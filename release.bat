@echo off

for /f "tokens=*" %%i in ('node -e "console.log(require('./package.json').version)"') do set "prevVersion=%%i"
echo Current version: %prevVersion%

set "dirty="
for /f "delims=" %%i in ('git status --porcelain') do set "dirty=1"

set /p "version=Enter new version number: "
if "%version%"=="" set "version=patch"

set "message="
if defined dirty set /p "message=Enter commit message: "
if defined dirty if "%message%"=="" set "message=update"

rem the working tree goes in first, so the tagged commit holds only the build
if defined dirty git add .
if defined dirty git commit -m "%message%"

rem bumped before building, so the crate compiles as the version that ships
call npm version %version% --no-git-tag-version

for /f "tokens=*" %%i in ('node -e "console.log(require('./package.json').version)"') do set "newVersion=%%i"

call npm run build:wasm
if errorlevel 1 (
  echo wasm build failed, stopping.
  pause
  exit /b 1
)

call npm run build:assets
if errorlevel 1 (
  echo assets build failed, stopping.
  pause
  exit /b 1
)

call npm run build
if errorlevel 1 (
  echo build failed, stopping.
  pause
  exit /b 1
)

git add .
git commit -m "release v%newVersion%"

git tag v%newVersion% HEAD

git push
git push --tags

call npm whoami 2>&1 | find "E401" >nul
if %errorlevel%==0 (
  echo Not logged in to npm. Starting login...
  call npm login
)

call npm publish

pause
