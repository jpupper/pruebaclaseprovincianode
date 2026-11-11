@echo off
set PORT=3000
echo ========================================================
echo       Iniciando Servidor - Minecraft 3D Editor
echo ========================================================
echo.
echo Puerto de la aplicacion: %PORT%
echo Puedes abrir tu navegador en: http://localhost:%PORT%
echo.
echo Presiona Ctrl + C para detener el servidor.
echo ========================================================
node server.js
pause

