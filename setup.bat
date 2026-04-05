@echo off
SETLOCAL EnableDelayedExpansion

echo ==========================================
echo   TinyBigTalks Backend Setup
echo ==========================================

:: 1. Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install it from https://nodejs.org/
    pause
    exit /b
)
echo [SUCCESS] Node.js detected.

:: 2. Install Dependencies
echo [INFO] Installing NPM dependencies...
npm install

:: 3. Redis Check
echo [INFO] Checking for Redis...
where redis-server >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] Redis server (redis-server) not found in system path.
    echo Ensure Redis is running on localhost:6379 for best performance.
) else (
    echo [SUCCESS] Redis detected.
)

:: 4. Final instructions
echo.
echo ==========================================
echo   Setup Complete!
echo ==========================================
echo To start the backend:
echo ^> npm start
echo.
echo Ensure your Redis server is running separately.
pause
