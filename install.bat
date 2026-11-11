@echo off
echo ========================================================
echo    Instalando dependencias de Minecraft 3D Editor...
echo ========================================================
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo Error durante la instalacion de dependencias.
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo Dependencias instaladas con exito!
echo Ahora puedes ejecutar 'run.bat' para iniciar la aplicacion.
pause

