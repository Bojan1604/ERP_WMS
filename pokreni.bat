@echo off
REM Pokretanje u brzom (produkcijskom) nacinu. Prvi put i nakon svakog azuriranja traje minutu-dvije (izgradnja).
cd /d %~dp0
if not exist node_modules call npm install
call npx prisma migrate deploy
call npm run build
npm run start
