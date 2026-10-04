"""Exercise actual macOS signing, quarantine and installation in temporary folders."""

from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "darwin", "Requires macOS codesign and xattr")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="notetaker-installer-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "image" / "AI Notetaker.app"
        self.destination = self.root / "Applications"
        self.target = self.destination / "AI Notetaker.app"
        binary_dir = self.source / "Contents" / "MacOS"
        binary_dir.mkdir(parents=True)
        for name in ("notetaker-helper", "notetaker-nm-host"):
            shutil.copyfile("/usr/bin/true", binary_dir / name)
            (binary_dir / name).chmod(0o755)
        self.plist = self.source / "Contents" / "Info.plist"
        self.plist.write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "com.ainotetaker.helper",
            "CFBundleExecutable": "notetaker-helper",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.0.0",
        }))
        self.hook = self.source / "Contents/Resources/scripts/install-native-messaging.sh"
        self.hook.parent.mkdir(parents=True)
        # This fixture never writes the user's actual browser configuration.
        self.hook.write_text('#!/bin/sh\nprintf "%s" "$1" > "$1/../registered-path"\n')
        shutil.copy2(ROOT / "packaging/macos/install.command", self.root / "image/install.command")
        self.sign()

    def run_command(self, *args, check=True):
        return subprocess.run(args, capture_output=True, text=True, check=check)

    def sign(self):
        self.run_command("bash", str(ROOT / "packaging/macos/sign-app.sh"), str(self.source))

    def install(self):
        return self.run_command(
            "bash", str(self.root / "image/install.command"),
            "--destination", str(self.destination), "--allow-unnotarized", "--no-open",
            check=False,
        )

    def test_installs_registers_and_removes_only_app_quarantine(self):
        self.run_command("xattr", "-w", "com.apple.quarantine", "0081;00000000;Test;", str(self.source))
        self.run_command("xattr", "-w", "com.ainotetaker.test", "keep", str(self.source))
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.run_command("codesign", "--verify", "--deep", "--strict", str(self.target))
        self.assertEqual((self.destination / "registered-path").read_text(), str(self.target))
        attrs = self.run_command("xattr", str(self.target)).stdout
        self.assertNotIn("com.apple.quarantine", attrs)
        self.assertIn("com.ainotetaker.test", attrs)
        self.assertIn("com.apple.quarantine", self.run_command("xattr", str(self.source)).stdout)

    def test_reinstall_preserves_unrelated_recordings(self):
        self.assertEqual(self.install().returncode, 0)
        audio = self.destination / "recording.pcm"
        audio.write_bytes(b"saved-audio")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(audio.read_bytes(), b"saved-audio")
        self.assertEqual(list(self.destination.glob(".ai-notetaker-install.*")), [])

    def test_tampered_resource_is_rejected_before_replacing_previous_app(self):
        self.assertEqual(self.install().returncode, 0)
        self.hook.write_text("#!/bin/sh\nexit 42\n")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("integrity check", result.stderr)
        self.run_command("codesign", "--verify", "--deep", "--strict", str(self.target))

    def test_does_not_replace_unrelated_app(self):
        (self.target / "Contents").mkdir(parents=True)
        other_plist = self.target / "Contents/Info.plist"
        original = plistlib.dumps({"CFBundleIdentifier": "example.other"})
        other_plist.write_bytes(original)
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(other_plist.read_bytes(), original)

    def test_refuses_symbolic_link_target(self):
        self.destination.mkdir()
        self.target.symlink_to(self.source, target_is_directory=True)
        self.assertNotEqual(self.install().returncode, 0)
        self.assertTrue(self.target.is_symlink())

    def test_registration_failure_keeps_recoverable_installed_app(self):
        self.hook.write_text("#!/bin/sh\nexit 42\n")
        self.sign()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("desktop app is installed", result.stderr)
        self.assertIn("desktop recording works without it", result.stderr)
        self.run_command("codesign", "--verify", "--deep", "--strict", str(self.target))

    def test_missing_legacy_browser_resources_do_not_block_desktop_install(self):
        (self.source / "Contents/MacOS/notetaker-nm-host").unlink()
        self.hook.unlink()
        self.sign()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.run_command("codesign", "--verify", "--deep", "--strict", str(self.target))


if __name__ == "__main__":
    unittest.main(verbosity=2)
