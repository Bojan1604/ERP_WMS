@echo off
REM Pokretanje u brzom (produkcijskom) nacinu. Prvi put i nakon svakog azuriranja traje minutu-dvije (izgradnja).
cd /d %~dp0

REM Paketi se provjeravaju svaki put: nova verzija programa moze trebati nove pakete.
call npm install --no-audit --no-fund
if errorlevel 1 goto greska

call npx prisma migrate deploy
if errorlevel 1 goto greska

call npm run build
if errorlevel 1 goto greska

npm run start
goto kraj

:greska
echo.
echo *** Pokretanje je zaustavljeno zbog greske (vidi poruku iznad). ***
echo Program NIJE pokrenut. Posaljite snimku ove poruke.
pause

:kraj
