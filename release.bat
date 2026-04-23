@echo off

for /f "tokens=*" %%i in ('node -e "console.log(require('./package.json').version)"') do set "prevVersion=%%i"
echo Current version: %prevVersion%

set /p "version=Enter new version number: "
if "%version%"=="" set "version=patch"

set /p "message=Enter commit message: "
if "%message%"=="" set "message=update"

git add .
git commit -m "%message%"

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
