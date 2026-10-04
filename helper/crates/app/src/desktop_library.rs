//! Local library organization. Folders are logical labels; meeting directories
//! and raw audio never move, so capture and recovery paths stay stable.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

const MAX_FOLDERS: usize = 2_000;
const MAX_DEPTH: usize = 8;
const MAX_NAME: usize = 80;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub placements: HashMap<Uuid, Uuid>,
}

pub struct DesktopLibrary {
    path: PathBuf,
    lock: Mutex<()>,
}

impl DesktopLibrary {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join("desktop-library.json"),
            lock: Mutex::new(()),
        }
    }

    pub fn snapshot(&self) -> Result<LibraryState, String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        self.read()
    }

    pub fn create(&self, parent_id: Option<Uuid>, raw_name: &str) -> Result<Folder, String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read()?;
        let name = clean_name(raw_name)?;
        if state.folders.len() >= MAX_FOLDERS {
            return Err("The library has reached its 2,000-folder limit.".into());
        }
        if parent_id.is_some_and(|id| !state.folders.iter().any(|folder| folder.id == id)) {
            return Err("The parent folder no longer exists.".into());
        }
        if depth(&state.folders, parent_id)? >= MAX_DEPTH {
            return Err("Folders can be nested eight levels deep.".into());
        }
        ensure_unique(&state.folders, parent_id, &name, None)?;
        let folder = Folder {
            id: Uuid::new_v4(),
            parent_id,
            name,
        };
        state.folders.push(folder.clone());
        self.write(&state)?;
        Ok(folder)
    }

    pub fn rename(&self, id: Uuid, raw_name: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read()?;
        let name = clean_name(raw_name)?;
        let parent_id = state
            .folders
            .iter()
            .find(|folder| folder.id == id)
            .ok_or("The folder no longer exists.")?
            .parent_id;
        ensure_unique(&state.folders, parent_id, &name, Some(id))?;
        state
            .folders
            .iter_mut()
            .find(|folder| folder.id == id)
            .unwrap()
            .name = name;
        self.write(&state)
    }

    pub fn move_folder(&self, id: Uuid, parent_id: Option<Uuid>) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read()?;
        let folder = state
            .folders
            .iter()
            .find(|folder| folder.id == id)
            .ok_or("The folder no longer exists.")?
            .clone();
        if folder.parent_id == parent_id {
            return Ok(());
        }
        if parent_id.is_some_and(|parent| !state.folders.iter().any(|item| item.id == parent)) {
            return Err("The destination folder no longer exists.".into());
        }
        let descendants = subtree(&state.folders, id);
        if parent_id.is_some_and(|parent| descendants.contains(&parent)) {
            return Err("A folder cannot be moved into itself or a child folder.".into());
        }
        let new_depth = depth(&state.folders, parent_id)? + height(&state.folders, id);
        if new_depth > MAX_DEPTH {
            return Err("Folders can be nested eight levels deep.".into());
        }
        ensure_unique(&state.folders, parent_id, &folder.name, Some(id))?;
        state
            .folders
            .iter_mut()
            .find(|item| item.id == id)
            .unwrap()
            .parent_id = parent_id;
        self.write(&state)
    }

    pub fn delete_empty(&self, id: Uuid) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read()?;
        if !state.folders.iter().any(|folder| folder.id == id) {
            return Err("The folder no longer exists.".into());
        }
        if state
            .folders
            .iter()
            .any(|folder| folder.parent_id == Some(id))
            || state.placements.values().any(|folder_id| *folder_id == id)
        {
            return Err("Move the notes and subfolders out before deleting this folder.".into());
        }
        state.folders.retain(|folder| folder.id != id);
        self.write(&state)
    }

    pub fn move_meeting(&self, meeting_id: Uuid, folder_id: Option<Uuid>) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read()?;
        if folder_id.is_some_and(|id| !state.folders.iter().any(|folder| folder.id == id)) {
            return Err("The destination folder no longer exists.".into());
        }
        if let Some(id) = folder_id {
            state.placements.insert(meeting_id, id);
        } else {
            state.placements.remove(&meeting_id);
        }
        self.write(&state)
    }

    pub fn forget_meeting(&self, meeting_id: Uuid) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.read()?;
        if state.placements.remove(&meeting_id).is_some() {
            self.write(&state)?;
        }
        Ok(())
    }

    fn read(&self) -> Result<LibraryState, String> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LibraryState::default())
            }
            Err(error) => return Err(format!("Library folders could not be opened: {error}")),
        };
        if file.metadata().map_err(|error| error.to_string())?.len() > MAX_FILE_BYTES {
            return Err("The library folder index is too large to read safely.".into());
        }
        let state: LibraryState = serde_json::from_reader(file)
            .map_err(|error| format!("Library folders could not be read: {error}"))?;
        validate(&state)?;
        Ok(state)
    }

    fn write(&self, state: &LibraryState) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("The library folder index is too large.".into());
        }
        let parent = self.path.parent().ok_or("Library path is unavailable.")?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Library folder could not be created: {error}"))?;
        let temp = parent.join(format!(".desktop-library-{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            fs::rename(&temp, &self.path).map_err(|error| error.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result.map_err(|error| format!("Library folders could not be saved: {error}"))
    }
}

fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Enter a folder name.".into());
    }
    if name.chars().count() > MAX_NAME {
        return Err("Use 80 characters or fewer.".into());
    }
    if name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err("Choose a folder name without slashes or control characters.".into());
    }
    Ok(name)
}

fn ensure_unique(
    folders: &[Folder],
    parent_id: Option<Uuid>,
    name: &str,
    except: Option<Uuid>,
) -> Result<(), String> {
    if folders.iter().any(|folder| {
        folder.parent_id == parent_id
            && Some(folder.id) != except
            && folder.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err("A folder with that name already exists here.".into());
    }
    Ok(())
}

fn depth(folders: &[Folder], id: Option<Uuid>) -> Result<usize, String> {
    let mut current = id;
    let mut seen = HashSet::new();
    let mut result = 0;
    while let Some(id) = current {
        if !seen.insert(id) {
            return Err("The library folder tree contains a cycle.".into());
        }
        let folder = folders
            .iter()
            .find(|folder| folder.id == id)
            .ok_or("The library folder tree has a missing parent.")?;
        result += 1;
        current = folder.parent_id;
    }
    Ok(result)
}

fn subtree(folders: &[Folder], id: Uuid) -> HashSet<Uuid> {
    let mut result = HashSet::new();
    let mut pending = vec![id];
    while let Some(next) = pending.pop() {
        if result.insert(next) {
            pending.extend(
                folders
                    .iter()
                    .filter(|folder| folder.parent_id == Some(next))
                    .map(|folder| folder.id),
            );
        }
    }
    result
}

fn height(folders: &[Folder], id: Uuid) -> usize {
    let children = folders.iter().filter(|folder| folder.parent_id == Some(id));
    1 + children
        .map(|child| height(folders, child.id))
        .max()
        .unwrap_or(0)
}

fn validate(state: &LibraryState) -> Result<(), String> {
    if state.folders.len() > MAX_FOLDERS {
        return Err("The library has too many folders.".into());
    }
    let ids = state
        .folders
        .iter()
        .map(|folder| folder.id)
        .collect::<HashSet<_>>();
    if ids.len() != state.folders.len() {
        return Err("The library contains duplicate folder ids.".into());
    }
    for folder in &state.folders {
        clean_name(&folder.name)?;
        if depth(&state.folders, Some(folder.id))? > MAX_DEPTH {
            return Err("A library folder is nested too deeply.".into());
        }
        ensure_unique(
            &state.folders,
            folder.parent_id,
            &folder.name,
            Some(folder.id),
        )?;
    }
    if state.placements.values().any(|id| !ids.contains(id)) {
        return Err("A recording refers to a missing library folder.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_nested_folders_and_note_placement() {
        let temp = tempfile::tempdir().unwrap();
        let library = DesktopLibrary::new(temp.path().to_path_buf());
        let clients = library.create(None, " Clients ").unwrap();
        let acme = library.create(Some(clients.id), "Acme").unwrap();
        let meeting = Uuid::new_v4();
        library.move_meeting(meeting, Some(acme.id)).unwrap();
        let reopened = DesktopLibrary::new(temp.path().to_path_buf());
        assert_eq!(
            reopened.snapshot().unwrap().placements.get(&meeting),
            Some(&acme.id)
        );
        assert_eq!(reopened.snapshot().unwrap().folders[0].name, "Clients");
        assert!(reopened.delete_empty(clients.id).is_err());
        assert!(reopened.delete_empty(acme.id).is_err());
        reopened.forget_meeting(meeting).unwrap();
        assert!(!reopened
            .snapshot()
            .unwrap()
            .placements
            .contains_key(&meeting));
        reopened.delete_empty(acme.id).unwrap();
        reopened.delete_empty(clients.id).unwrap();
    }

    #[test]
    fn rejects_duplicate_cycle_and_unsafe_names() {
        let temp = tempfile::tempdir().unwrap();
        let library = DesktopLibrary::new(temp.path().to_path_buf());
        let first = library.create(None, "Clients").unwrap();
        let child = library.create(Some(first.id), "Acme").unwrap();
        assert!(library.create(None, "clients").is_err());
        assert!(library.create(None, "../secret").is_err());
        assert!(library.move_folder(first.id, Some(child.id)).is_err());
        assert!(library.move_folder(child.id, None).is_ok());
        assert!(library.rename(child.id, "clients").is_err());
    }

    #[test]
    fn malformed_index_is_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("desktop-library.json");
        fs::write(&path, b"{broken").unwrap();
        let library = DesktopLibrary::new(temp.path().to_path_buf());
        assert!(library.create(None, "Clients").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
    }
}
