@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8623
set PAGE=index.html

rem 端口被占用则顺延（参照 Mac 版逻辑）
:findport
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  set /a PORT+=1
  goto findport
)

echo ───────────────────────────────────────
echo  照片地图启动中...
echo  电脑访问：http://localhost:%PORT%/%PAGE%
echo  手机访问：用 ipconfig 查本机 IP，同 WiFi 下访问 http://本机IP:%PORT%/%PAGE%
echo  关闭此窗口即停止服务
echo ───────────────────────────────────────

start "" "http://localhost:%PORT%/%PAGE%"
python -m http.server %PORT% 2>nul || py -m http.server %PORT%
pause
