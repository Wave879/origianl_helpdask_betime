@echo off
setlocal

set "ROOT=%~dp0.."
set "PY=C:\Users\wave\AppData\Local\Programs\Python\Python310\python.exe"

if "%MOM_BRIDGE_PORT%"=="" set "MOM_BRIDGE_PORT=9001"
if "%AZURE_SPEECH_REGION%"=="" set "AZURE_SPEECH_REGION=eastus"

if not exist "%PY%" (
  set "PY=python"
)

cd /d "%ROOT%"
"%PY%" -u "scripts\mom_bridge_server.py"
