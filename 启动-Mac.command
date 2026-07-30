#!/bin/bash
# 双击启动照片地图（Mac）
cd "$(dirname "$0")"
PORT=8623
PAGE="index.html"

# 端口被占用则顺延
while lsof -i :$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done

python3 -m http.server $PORT >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1
open "http://localhost:$PORT/$PAGE"

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "本机IP")
echo "───────────────────────────────────────"
echo " 照片地图已启动"
echo " 电脑访问：http://localhost:$PORT/$PAGE"
echo " 手机访问：http://$IP:$PORT/$PAGE  （需同一 WiFi）"
echo " 关闭此窗口即停止服务"
echo "───────────────────────────────────────"
wait $SERVER_PID
