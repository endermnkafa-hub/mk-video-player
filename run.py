"""MK VideoPlayer başlatıcı betiği.

Varsayılan olarak gömülü Chromium tarayıcısı ve özel video oynatıcısını barındıran
Electron masaüstü uygulamasını başlatır (Electron kendi içinde FastAPI arka ucunu yönetir).

Yalnızca arka uç sunucusunu test amaçlı başlatmak için:
    python run.py --backend-only
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="MK VideoPlayer Başlatıcı")
    parser.add_argument("--backend-only", action="store_true", help="Yalnızca FastAPI arka ucunu başlatır (masaüstü arayüzü olmadan)")
    parser.add_argument("--port", type=int, default=8000, help="Arka uç portu (varsayılan: 8000)")
    parser.add_argument("--host", default="127.0.0.1", help="Arka uç hostu (varsayılan: 127.0.0.1)")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    os.chdir(project_dir)

    if args.backend_only:
        print("\n" + "=" * 60)
        print(" 🎬 MK VideoPlayer Arka Ucu (Yalnızca API/Statik) Başlatılıyor...")
        print(f" 🌐 Adres: http://{args.host}:{args.port}")
        print(" 💡 Çıkış için: Ctrl + C")
        print("=" * 60 + "\n")
        import uvicorn
        uvicorn.run("app.main:app", host=args.host, port=args.port, reload=True)
        return 0

    print("\n" + "=" * 60)
    print(" 🎬 MK VideoPlayer Masaüstü Uygulaması Başlatılıyor...")
    print(" 🖥️  Gömülü Chromium Tarayıcı + HLS/MP4 Özel Oynatıcı")
    print("=" * 60 + "\n")

    # npm veya npx/electron ile masaüstü uygulamasını başlat
    npm_path = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm_path:
        print("[HATA] 'npm' komutu bulunamadı. Lütfen Node.js yüklü olduğundan emin olun.", file=sys.stderr)
        return 1

    try:
        proc = subprocess.run([npm_path, "start"], cwd=str(project_dir))
        return proc.returncode
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
