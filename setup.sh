#!/bin/bash
# ============================================
# 🚀 YT Bilingual App - 一键安装脚本
# ============================================
# 使用方法: chmod +x setup.sh && ./setup.sh
#
# 需要一个 Python >= 3.10。脚本会按下面的顺序自动挑选：
#   1. 环境变量 $PYTHON
#   2. PATH 上的 python3.13 / 3.12 / 3.11 / 3.10 / python3（版本不够的会跳过）
#   3. 仓库外层已重签好的 .cache/py3XX
#   4. 本机 DSH 运行时自带的 python（会自动复制并 ad-hoc 重签名）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "====================================="
echo "🔧 YT Bilingual App 安装程序"
echo "====================================="

# --- 判断某解释器是否 >= 3.10 -------------------------------------------
py_version_ok() {
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

# --- 判断某二进制是否带 macOS hardened runtime --------------------------
# 带 runtime 标志的进程只允许加载「同 Team ID 签名」的动态库；pip 装的
# wheel（ad-hoc 签名）会因此报 "different Team IDs" 而 import 失败。
py_is_hardened() {
    command -v codesign >/dev/null 2>&1 || return 1
    codesign -dv "$1" 2>&1 | grep -qE 'flags=0x[0-9a-f]+\(runtime'
}

# --- 把带 hardened runtime 的解释器复制一份、ad-hoc 重签名 -------------
# 结果放到仓库外层的 .cache/py3XX/，自包含（复制标准库），可长期复用。
# 成功后路径写入全局变量 RELOCATED_PY。
RELOCATED_PY=""
relocate_python() {
    local src="$1" prefix ver tag dest real
    prefix=$("$src" -c 'import sys; print(sys.base_prefix)')
    ver=$("$src" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
    tag="py${ver//./}"
    dest="$SCRIPT_DIR/../.cache/$tag"

    if [ -x "$dest/bin/python$ver" ] && py_version_ok "$dest/bin/python$ver"; then
        RELOCATED_PY="$dest/bin/python$ver"
        return 0
    fi

    echo "  ⚠️  $src 带 hardened runtime，原生扩展会加载失败——重签一份到 $dest" >&2
    mkdir -p "$dest/bin" "$dest/lib"
    real=$("$src" -c 'import os, sys; print(os.path.realpath(sys._base_executable))')
    cp "$real" "$dest/bin/python$ver"
    chmod +x "$dest/bin/python$ver"
    codesign --force --sign - "$dest/bin/python$ver" >/dev/null 2>&1
    if [ ! -f "$dest/lib/python$ver/os.py" ]; then
        rm -rf "$dest/lib/python$ver"
        cp -R "$prefix/lib/python$ver" "$dest/lib/python$ver"
    fi
    if [ -f "$prefix/lib/libpython$ver.dylib" ] && [ ! -f "$dest/lib/libpython$ver.dylib" ]; then
        cp "$prefix/lib/libpython$ver.dylib" "$dest/lib/"
    fi

    if py_version_ok "$dest/bin/python$ver" && ! py_is_hardened "$dest/bin/python$ver"; then
        RELOCATED_PY="$dest/bin/python$ver"
        return 0
    fi
    echo "  ❌ 重签名后的解释器仍不可用" >&2
    return 1
}

# --- 挑选可用的 Python（输出到 stdout）----------------------------------
find_python() {
    local cand real
    for cand in "${PYTHON:-}" python3.13 python3.12 python3.11 python3.10 python3 \
                "$SCRIPT_DIR/../.cache/py312/bin/python3.12" \
                "$HOME"/.dsh/dsh-runtimes/*/dependencies/python/bin/python3; do
        [ -n "$cand" ] || continue
        if ! [ -x "$cand" ] && ! command -v "$cand" >/dev/null 2>&1; then
            continue
        fi
        py_version_ok "$cand" || continue

        real=$("$cand" -c 'import os, sys; print(os.path.realpath(sys._base_executable))' 2>/dev/null || true)
        if [ -n "$real" ] && py_is_hardened "$real"; then
            RELOCATED_PY=""
            relocate_python "$cand" || continue
            echo "$RELOCATED_PY"
            return 0
        fi
        echo "$cand"
        return 0
    done
    return 1
}

if ! PYTHON_BIN=$(find_python); then
    echo "❌ 未找到 Python 3.10+"
    echo "   请安装 Python 3.10 或更新版本（https://www.python.org/downloads/），"
    echo "   或用 PYTHON=/path/to/python3.12 ./setup.sh 指定解释器。"
    exit 1
fi
echo "✅ Python: $("$PYTHON_BIN" --version 2>&1)  ($PYTHON_BIN)"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未找到 Node.js，请先安装 Node.js 18+"
    exit 1
fi
echo "✅ Node.js: $(node --version)"

# 检查 npm
if ! command -v npm &> /dev/null; then
    echo "❌ 未找到 npm"
    exit 1
fi
echo "✅ npm: $(npm --version)"

echo ""
echo "[1/3] 🐍 设置 Python 后端..."
cd "$SCRIPT_DIR/backend"

# 已有 venv：版本够 + 解释器不带 hardened runtime 才复用
venv_ok=0
if [ -x "venv/bin/python" ]; then
    if py_version_ok venv/bin/python; then
        venv_real=$(venv/bin/python -c 'import os, sys; print(os.path.realpath(sys._base_executable))' 2>/dev/null || true)
        if [ -n "$venv_real" ] && ! py_is_hardened "$venv_real"; then
            venv_ok=1
        fi
    fi
fi

if [ "$venv_ok" = "0" ]; then
    if [ -d "venv" ]; then
        echo "  ♻️  现有 venv 不可用（Python 版本不足或被 hardened runtime 限制），重建中…"
        rm -rf venv
    fi
    "$PYTHON_BIN" -m venv venv
    echo "  ✅ 创建虚拟环境 ($("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])'))"
else
    echo "  ✅ 虚拟环境已存在"
fi

venv/bin/python -m pip install -q -r requirements.txt
echo "  ✅ Python 依赖安装完成"

echo ""
echo "[2/3] 📦 设置前端..."
cd "$SCRIPT_DIR/frontend"
if [ -f "package-lock.json" ]; then
    npm ci --silent --no-audit --no-fund
else
    npm install --silent --no-audit --no-fund
fi
echo "  ✅ 前端依赖安装完成"

echo ""
echo "[3/3] 🔑 检查配置..."
cd "$SCRIPT_DIR"
if [ ! -f ".env" ]; then
    echo "GEMINI_API_KEY=\"your_gemini_api_key_here\"" > .env
    echo "  ⚠️  已创建 .env 文件，请编辑并填入你的 Gemini API Key："
    echo "     $SCRIPT_DIR/.env"
else
    echo "  ✅ .env 文件已存在"
fi

# 确保 start_app.command 有执行权限
chmod +x start_app.command

echo ""
echo "====================================="
echo "✅ 安装完成！"
echo "====================================="
echo ""
echo "📝 下一步："
echo "  1. 编辑 .env 文件，填入你的 GEMINI_API_KEY"
echo "  2. 双击 start_app.command 启动应用"
echo "  3. 或运行: ./start_app.command"
echo ""
echo "  浏览器访问: http://localhost:5173"
echo ""
