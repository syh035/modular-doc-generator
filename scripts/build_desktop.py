"""Build a native macOS launcher for the self-contained resource bundle (no shell app stub)."""

import argparse
import hashlib
import json
import platform
import plistlib
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


def _build_bundle(root: Path, output: Path, arch: str, signing_identity: str) -> Path:
    app = output / "模块化文档生成助手.app"
    contents = app / "Contents"
    macos, resources = contents / "MacOS", contents / "Resources"
    macos.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "xcrun",
            "swiftc",
            "-swift-version",
            "5",
            "-warnings-as-errors",
            "-O",
            "-module-name",
            "ModularDocLauncher",
            "-target",
            f"{arch}-apple-macosx14.0",
            str(root / "desktop/ServiceManager.swift"),
            str(root / "desktop/Launcher.swift"),
            str(root / "desktop/Workbench.swift"),
            str(root / "desktop/Runtime.swift"),
            "-o",
            str(macos / "ModularDocLauncher"),
        ],
        check=True,
    )
    bundle_id = "local.syh035.modular-doc-generator"
    info = {
        "CFBundleIdentifier": bundle_id,
        "CFBundleName": "模块化文档生成助手",
        "CFBundleDisplayName": "模块化文档生成助手",
        "CFBundleExecutable": "ModularDocLauncher",
        "CFBundlePackageType": "APPL",
        "CFBundleVersion": "3",
        "CFBundleShortVersionString": "1.3.0",
        "LSUIElement": False,
        "LSMinimumSystemVersion": "14.0",
        "NSDocumentsFolderUsageDescription": "访问所选本地项目，保存模板、字符块与导出文件。",
        "NSLocalNetworkUsageDescription": "连接本机文档服务以检查状态并打开工作台。",
    }
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    (resources / "launcher.json").write_text(json.dumps({"mode": "packaged"}), encoding="utf-8")
    shutil.copytree(root / "backend/app", resources / "backend/app",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(root / "frontend/dist", resources / "frontend")
    shutil.copyfile(root / "backend/requirements-release.txt", resources / "requirements-release.txt")
    shutil.copyfile(root / "scripts/migrate_data.py", resources / "migrate_data.py")
    shutil.copyfile(root / "LICENSE", resources / "LICENSE")
    shutil.copyfile(root / "desktop/LICENSE-AGPL-3.0.txt", resources / "LICENSE-AGPL-3.0.txt")
    shutil.copyfile(root / "desktop/DISTRIBUTION.md", resources / "DISTRIBUTION.md")
    environment_id = hashlib.sha256((resources / "requirements-release.txt").read_bytes()).hexdigest()[:16]
    (resources / "environment-id").write_text(f"py312-{arch}-{environment_id}", encoding="utf-8")
    platform_tag = "macosx_14_0_arm64" if arch == "arm64" else "macosx_14_0_x86_64"
    subprocess.run([
        str(root / "backend/.venv/bin/python"), "-m", "pip", "download", "--only-binary=:all:",
        "--python-version", "3.12", "--implementation", "cp", "--abi", "cp312",
        "--platform", platform_tag, "--dest", str(resources / "wheels"),
        "-r", str(resources / "requirements-release.txt"),
    ], check=True)
    # Wheels retain their original notices; expose copies beside the app notices.
    notices = resources / "ThirdPartyLicenses"
    for wheel in (resources / "wheels").glob("*.whl"):
        with zipfile.ZipFile(wheel) as archive:
            for name in archive.namelist():
                if not name.endswith("/") and any(
                    part.lower().startswith(("license", "copying", "notice"))
                    for part in Path(name).parts
                ):
                    target = notices / wheel.stem / Path(name).name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(name))
    for manifest in (root / "frontend/node_modules").rglob("package.json"):
        for entry in manifest.parent.iterdir():
            if entry.is_file() and entry.name.lower().startswith(("license", "copying", "notice")):
                target = notices / "frontend" / entry.relative_to(root / "frontend/node_modules")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(entry, target)
    # Strip only Finder/resource-fork metadata on generated output, not quarantine.
    for entry in [app, *app.rglob("*")]:
        for attribute in ("com.apple.FinderInfo", "com.apple.ResourceFork"):
            attributes = subprocess.check_output(["xattr", str(entry)], text=True).splitlines()
            if attribute in attributes:
                subprocess.run(["xattr", "-d", attribute, str(entry)], check=True)
    subprocess.run(
        ["codesign", "--sign", signing_identity, "--identifier", bundle_id,
         *([] if signing_identity == "-" else ["--options", "runtime", "--timestamp"]), str(app)],
        check=True,
    )
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
    return app


def build(root: Path, output: Path, arch: str, signing_identity: str = "-") -> Path:
    # File-provider directories can immediately recreate FinderInfo. Sign on a
    # local staging volume, then copy ordinary file contents and verify delivery.
    with tempfile.TemporaryDirectory(prefix="modudoc-build-") as stage:
        staged = _build_bundle(root, Path(stage), arch, signing_identity)
        target = output / staged.name
        if target.exists():
            info_path = target / "Contents/Info.plist"
            if (
                not info_path.is_file()
                or plistlib.loads(info_path.read_bytes()).get("CFBundleIdentifier")
                != "local.syh035.modular-doc-generator"
            ):
                raise RuntimeError("Refusing to replace an unrelated application")
            shutil.rmtree(target)
        output.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staged, target, copy_function=shutil.copyfile)
        (target / "Contents/MacOS/ModularDocLauncher").chmod(0o755)
        subprocess.run(["codesign", "--verify", "--strict", str(target)], check=True)
        return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--arch", choices=["arm64", "x86_64"], default=platform.machine())
    parser.add_argument("--signing-identity", default="-")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    print(build(root, (args.output or root / "desktop/build").resolve(), args.arch, args.signing_identity))


if __name__ == "__main__":
    main()
