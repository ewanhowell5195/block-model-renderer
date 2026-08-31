@echo off

for /f "tokens=*" %%i in ('node -e "console.log(require('./package.json').version)"') do set "prevVersion=%%i"
echo Current version: %prevVersion%

set /p "version=Enter new version number: "
if "%version%"=="" set "version=patch"

rem before the dirty check, so a rebuilt wasm goes into the commit that gets tagged
call npm run build:wasm
if errorlevel 1 (
  echo wasm build failed, stopping.
  pause
  exit /b 1
)

set "dirty="
for /f "delims=" %%i in ('git status --porcelain') do set "dirty=1"

set "message="
if defined dirty set /p "message=Enter commit message: "
if defined dirty if "%message%"=="" set "message=update"

if defined dirty git add .
if defined dirty git commit -m "%message%"

call npm version %version%

git push
git push --tags

call npm whoami 2>&1 | find "E401" >nul
if %errorlevel%==0 (
  echo Not logged in to npm. Starting login...
  call npm login
)

call npm publish

pause
