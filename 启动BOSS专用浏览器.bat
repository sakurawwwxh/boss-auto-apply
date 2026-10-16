@echo off
chcp 65001 >nul
rem ============================================================
rem  BOSS 自动投递：专用 Chrome 启动器
rem  - 独立 profile（里面只有这个插件，没有别的自动化工具）
rem  - 不挂调试端口，BOSS 那套本机端口探测扫不到东西
rem  - Chrome 155 已禁止命令行 --load-extension 侧载，所以插件要
rem    在本 profile 里手工装一次（首次运行会提示并打开扩展页）
rem ============================================================
setlocal
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "PROFILE=%LOCALAPPDATA%\BossToolProfile"
set "EXT=%~dp0"
set "URL=https://www.zhipin.com/web/geek/jobs"
set "EXTRA="

if not exist "%CHROME%" (
  echo [x] 找不到 Chrome：%CHROME%
  pause
  exit /b 1
)
if not exist "%EXT%manifest.json" (
  echo [x] 这个 bat 旁边没有 manifest.json，请把它放在 boss-auto-apply 目录里
  pause
  exit /b 1
)

rem 用「profile 里还没有 Preferences」判断是不是第一次跑。
rem 别用 findstr 去搜 Secure Preferences：那文件是超长单行，findstr 有行长上限、搜不到。
if not exist "%PROFILE%\Default\Preferences" (
  set "EXTRA=chrome://extensions/"
  echo.
  echo  首次使用：在这个窗口里装一次插件（只需一次，之后会一直记住）
  echo    1. 已帮你打开 chrome://extensions/
  echo    2. 右上角打开「开发者模式」
  echo    3. 左上角点「加载已解压的扩展程序」，选这个目录：
  echo       %EXT%
  echo.
  echo  装完回到 BOSS 岗位列表页，右下角就会出现面板。
  echo  这个浏览器只用来跑 BOSS：别开 F12、别装其他自动化扩展。
  echo.
)

start "" "%CHROME%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --new-window %EXTRA% "%URL%"
endlocal
