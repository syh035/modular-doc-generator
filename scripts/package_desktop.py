"""Archive a verified app without removing macOS security metadata."""

import argparse
import hashlib
import plistlib
import subprocess
from pathlib import Path


def package(app: Path, output: Path, arch: str) -> Path:
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    version = info["CFBundleShortVersionString"]
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"ModularDocGenerator-{version}-macOS-{arch}.zip"
    if archive.exists():
        raise FileExistsError(f"Archive already exists: {archive}")
    subprocess.run(["ditto", "-c", "-k", "--keepParent", str(app), str(archive)], check=True)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--arch", choices=["arm64", "x86_64"], required=True)
    args = parser.parse_args()
    print(package(args.app.resolve(), args.output.resolve(), args.arch))


if __name__ == "__main__":
    main()
