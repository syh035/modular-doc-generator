"""Compile and run native service lifecycle tests on disposable loopback fixtures."""

import json
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path


def port() -> int:
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return int(connection.getsockname()[1])


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js required")
    with tempfile.TemporaryDirectory(prefix="M25 临时 空格 ") as temp:
        fixture = Path(temp)
        backend, frontend = fixture / "backend", fixture / "frontend"
        (backend / ".venv/bin").mkdir(parents=True)
        (backend / "app").mkdir()
        (backend / "app/main.py").write_text("# Fixture only\n")
        (frontend / "node_modules/vite/bin").mkdir(parents=True)
        (frontend / "package.json").write_text("{}")
        python = backend / ".venv/bin/python"
        interpreter = root / "backend/.venv/bin/python"
        python.write_text(
            f"#!{interpreter}\n"
            + """import hashlib,json,sys,os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
port=int(sys.argv[sys.argv.index('--port')+1])
root=Path.cwd().parent.resolve()
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers()
  self.wfile.write(json.dumps({'status':'ok','libreoffice':{},'application':'modular-doc-generator',
    'data_fingerprint':hashlib.sha256(str(Path(os.environ.get('MODUDOC_DATA_DIR',str(root/'data'))).resolve()).encode()).hexdigest(),
    'project_fingerprint':hashlib.sha256(str(root).encode()).hexdigest()}).encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',port),Handler).serve_forever()
"""
        )
        python.chmod(0o755)
        (
            frontend / "node_modules/vite/bin/vite.js"
        ).write_text("""const http = require('http'), fs = require('fs'), path = require('path');
const root = path.dirname(process.cwd());
if(fs.existsSync(path.join(root,'fail.flag'))) process.exit(23);
const port = Number(process.argv[process.argv.indexOf('--port')+1]);
http.createServer((req,res)=>{
 res.end(fs.existsSync(path.join(root,'foreign.flag'))?'Other app':'模块化文档生成助手');
}).listen(port,'localhost');
""")
        binary = fixture / "NativeServiceTests"
        subprocess.run(
            [
                "xcrun",
                "swiftc",
                "-swift-version",
                "5",
                "-warnings-as-errors",
                str(root / "desktop/ServiceManager.swift"),
                str(root / "desktop/ServiceManagerTests.swift"),
                str(root / "desktop/Workbench.swift"),
                str(root / "desktop/Runtime.swift"),
                "-o",
                str(binary),
            ],
            check=True,
        )
        backend_port, frontend_port = port(), port()
        while frontend_port == backend_port:
            frontend_port = port()
        try:
            subprocess.run(
                [str(binary), str(fixture), node, str(backend_port), str(frontend_port)],
                check=True,
                timeout=120,
            )
        except subprocess.SubprocessError:
            for log in (fixture / "logs").glob("*.log"):
                print(log.name, log.read_text(), flush=True)
            raise
        print(json.dumps({"native_lifecycle": "passed", "production_ports_used": False}))


if __name__ == "__main__":
    main()
