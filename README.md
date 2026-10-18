# Gear Inventory

Keep track of your equipment, where it is, how you acquired it, and what has happened to it. Gear Inventory is a small, self-hosted web application with a Python backend and a SQLite database. It runs in Docker, on TrueNAS SCALE Apps, or directly with Python.

**English is the default interface language.** Use the language selector to switch to **Magyar**. Your choice is remembered in that browser, including on the sign-in screen. Item names, locations, notes and other text you enter stay as you wrote them.

[English guide](#english-guide) · [Magyar útmutató](#magyar-útmutató)

## English guide

### What you can do

- Add, edit and delete equipment, attach photos/documents, and record repairs or measurements.
- Find items by search, device type, status, ownership and acquisition method. Sort by name, price or date.
- Select several items and change only the fields you choose with **Bulk edit**.
- Open filtered inventory lists directly from dashboard cards. Purchase-value totals keep currencies separate; they are not current market valuations.
- Review before/after values in the persistent audit log. Deleted items retain their audit history.
- Preview and import CSV files, or export the inventory in English or Hungarian.
- Use the persistent navigation and bottom-left audit shortcut on desktop or mobile.

One shared password protects this personal inventory. This is not a multi-user account system. Use a trusted LAN/VPN; public source code does not mean the running application should be exposed to the internet. For remote access, put it behind an HTTPS reverse proxy and appropriate access controls, and set `GEAR_COOKIE_SECURE=true`. Do not enable that setting for plain HTTP or the browser will not send the session cookie. There is no built-in password reset, MFA or login rate limiting.

### Start with Docker Compose

You need Docker with the Compose plugin. Clone the repository first, or download and extract its source ZIP:

```bash
git clone https://github.com/nmmiklos/gear-inventory.git
cd gear-inventory
```

Run these commands inside your checkout:

```bash
cp .env.example .env
```

Open `.env` in a text editor and set `GEAR_PASSWORD` to a long, unique password. Do not put the password in Git. Then run:

```bash
docker compose up -d --build
```

Open **http://localhost:8187** and sign in using that password. The database is created automatically; you do not need to run the demo script.

The default binds to `127.0.0.1`, so only the host can connect. For access from other computers on your trusted LAN, set `GEAR_BIND=0.0.0.0` in `.env`, recreate the container, and use `http://YOUR_SERVER_IP:8187`. The firewall and network must allow that port. Do not forward it directly from your router to the internet.

| Setting | Meaning | Default |
| --- | --- | --- |
| `GEAR_PASSWORD` | Required shared sign-in password | No default; empty refuses startup |
| `GEAR_COOKIE_SECURE` | Add Secure to session cookies when using HTTPS | `false` |
| `GEAR_PORT` | Host port used by Compose | `8187` |
| `GEAR_BIND` | Host address used by Compose | `127.0.0.1` |
| `GEAR_DATA_PATH` | Persistent host folder used by Compose | `./data` |
| `GEAR_DATA` | Data directory inside the application | `/data` in Docker |
| `PORT` | HTTP port inside the application | `8080` |

`compose.yaml` mounts your data folder at `/data` in the container. Keep it writable by the container. Changing the container or rebuilding the image does not remove that mounted data.

Useful commands:

```bash
docker compose ps
docker compose logs --tail 100 gear-inventory
docker compose stop
docker compose start
```

### Update an existing Compose installation

Make a backup first, then:

```bash
git pull --ff-only
docker compose up -d --build
```

Refresh the browser; use Ctrl+F5 if it still shows the previous interface. **Pulling source and restarting the old image is not enough: you must rebuild.** Startup applies the additive database changes automatically. A first visit defaults to English; existing inventory values and personal notes are preserved.

When updating from an older version, explicitly set `GEAR_BIND=0.0.0.0` in your local `.env` if you need to keep LAN access. The fallback is now local-host-only.

### TrueNAS SCALE Apps

Configure the app with the built image, a host port such as `8187` mapped to container port `8080`, a strong `GEAR_PASSWORD`, and a persistent host data directory mounted at `/data`. Keep `GEAR_DATA=/data`. Your app configuration determines which image tag must be built.

For an existing TrueNAS-managed app:

1. Stop the app from **Apps** and back up its entire host data folder.
2. Pull the source as the account that owns the checkout and its deployment credentials: `git pull --ff-only`.
3. Build the **exact image tag configured in that app**: `sudo docker build -t YOUR_CONFIGURED_IMAGE_TAG .`.
4. Start the app again from **Apps**, then refresh the browser.

Manage the existing app through TrueNAS Apps. Starting a second Compose deployment next to it can cause port/container-name conflicts. Do not replace the app's existing data mount with an empty directory. Source code is copied into the image at build time, so stop/start alone does not install new source files.

### Backups and restore

Your persistent data folder contains `gear.sqlite3`, SQLite WAL/SHM files when active, `session.key`, and `uploads/`. **Back up the whole folder.** A CSV export is useful for your item list, but it does not include attachment bytes, audit history or repair events and is not a complete backup.

For a simple, consistent backup, stop the app first. With a default Compose deployment:

```bash
docker compose stop
mkdir -p backups
cp -a ./data "./backups/data-$(date +%Y%m%d-%H%M%S)"
docker compose start
```

Confirm the copy succeeded before treating it as a backup; use the correct permissions for your host. For TrueNAS, use an appropriate dataset snapshot or copy the data folder while the app is stopped.

To restore, stop the app, keep a copy of its current data, restore the complete backup to the configured host data folder with correct permissions, then start the app. Never restore database files while it is running. Test a backup before relying on it. Do not commit or publish backup files, session keys or uploaded documents.

### CSV import and export

Use **CSV import → Download empty CSV template**, fill it in and upload it. Check the preview before importing. Choose whether any invalid row should cancel the entire import, or whether invalid rows should be skipped.

```text
name,category,brand,model,serial,status,location,acquired,price,acquisition_type,notes,parent_name
```

- Required columns: `name`, `category`, `status`. Other columns are optional. Unknown/repeated column names are rejected.
- UTF-8, with or without BOM; comma, semicolon or tab delimiter. Up to **1 MB / 500 items** per import. Quote cells that contain delimiters or newlines.
- Category, status and acquisition labels can be **English or Hungarian**, regardless of the selected interface language. Use the options shown in the application; unknown labels are reported in preview.
- `acquired` uses `YYYY-MM-DD`, or leave it empty. `price` is free text; e.g. `20000 HUF`, `100 EUR`. Empty means unknown; `0` means zero cost.
- `acquisition_type`: **Purchased / Gift / Trade / For a favour / Free to take / Unknown**, or the Hungarian equivalents below. Empty or missing means Unknown. **Zero cost never implies Gift.**
- Duplicates are detected by trimmed, case-insensitive **name + brand + model**, against existing items and earlier valid rows in the file. Import creates new records and never overwrites existing items.
- `parent_name` must uniquely match an item that **already exists**. To import parent-child groups into an empty inventory, import the parents first, then their children. Duplicate parent names need to be resolved before importing.
- The server validates again inside the write transaction, so a change after preview cannot silently bypass duplicate detection. Every imported item is audited with a shared batch ID.

**CSV export** downloads all items, including sold/given-away ones. Column names stay the same in both languages; category/status/acquisition labels use the selected language. Personal text stays unchanged. English and Hungarian exports can be imported under either interface language. Legacy/custom categories still need to be mapped to supported categories. An export from an existing inventory will be detected as duplicate if re-imported into the same inventory.

### Acquisition methods

| English | Magyar |
| --- | --- |
| Purchased | Vásárolt |
| Gift | Ajándék |
| Trade | Csere |
| For a favour | Szívességért |
| Free to take | Ingyen elvihető |
| Unknown | Ismeretlen |

Older items start as Unknown. Use Bulk edit to classify them. The dashboard acquisition breakdown counts **currently owned** items; sold/given-away items remain searchable using the ownership/status filters. Statuses and categories have translated labels while the database keeps its existing canonical identifiers for compatibility.

### Run locally without Docker

Use Python **3.12 or newer**. The backend uses only the standard library. Set environment variables in your shell; a local `.env` is read by Compose, not automatically by Python.

```bash
export GEAR_DATA=./data
export PORT=8080
read -r -s -p 'Inventory password: ' GEAR_PASSWORD
printf '\n'
export GEAR_PASSWORD
python3 app.py
```

Open http://localhost:8080. Direct Python execution listens on all interfaces; restrict access with your firewall. The commands above are for Bash; set equivalent environment variables in PowerShell or another shell as needed.

Optional fictional demo items (never run as a normal update step):

```bash
python3 seed.py
```

In Docker: `docker compose exec gear-inventory python seed.py`. It adds only fictional examples and does not modify matching existing items. Real personal inventory is not shipped in the current source.

### Development and tests

```bash
python3 tests/test_api.py
node tests/test_sorting.js
npm ci
npx playwright install chromium
npm run test:ui
```

The API/browser tests use temporary databases, not your live inventory. Browser tests require Node.js 20+ and Playwright; they check both languages, forms, audit, CSV and mobile navigation. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` only when you need a specific installed Chromium executable. No Node.js tooling is needed to run the application itself.

| File | Purpose |
| --- | --- |
| `app.py` | HTTP API, authentication, SQLite migration, audit, uploads and CSV |
| `static/app.js` | Inventory UI and interactions |
| `static/i18n.js`, `static/translations.json` | Language selection, translated text and locale handling |
| `static/catalog.json` | Canonical device types, statuses and acquisition methods |
| `static/sorting.js` | Sorting, ownership and dashboard calculations |
| `static/index.html`, `static/style.css` | Page layout and responsive styling |
| `seed.py` | Explicitly-run fictional examples |

User-entered content is not machine-translated. Native file/date dialogs and browser validation messages follow your browser/OS language. The application translates its own controls, labels, confirmations, API validation messages and CSV preview errors.

### Keep your data private

The source contains fictional demo items only. Runtime data, credentials, backups and exports are excluded by Git and Docker build rules. Inspect staged files before pushing: ignore rules do not protect files that were already tracked or explicitly force-added. Do not publish your actual inventory database, uploads, `.env`, SSH files, session keys or backups. Keep the running application behind trusted network/access controls even when its source is public.

## Magyar útmutató

### Mire használható?

Saját eszközeidet, beszerzéseidet, javításaidat és az előzményeiket tarthatod nyilván. Kereshetsz, szűrhetsz, rendezhetsz, több eszközt közösen szerkeszthetsz, fájlokat tölthetsz fel, valamint CSV-t importálhatsz és exportálhatsz. Az auditnapló megőrzi a változások előtti és utáni értékeket, törölt tételeknél is.

Az alapnyelv **angol**. A **Language / Nyelv** választóval magyarra válthatsz; a böngésző megjegyzi a választást. A saját elnevezések és jegyzetek nem változnak. A nyelvváltás a megnyitott űrlapok beírt értékeit és a kiválasztott CSV-fájlt is megőrzi.

### Telepítés Docker Compose-zal

Szükséges a Docker és a Compose plugin. A letöltött projekt mappájában:

```bash
cp .env.example .env
```

Nyisd meg a `.env` fájlt, és állíts be hosszú, egyedi `GEAR_PASSWORD` jelszót. Ezután:

```bash
docker compose up -d --build
```

Cím: **http://localhost:8187**. Az adatbázis automatikusan létrejön. Példaadatot nem kell betöltened.

Alapesetben csak a szervergép saját magáról éri el az alkalmazást (`GEAR_BIND=127.0.0.1`). Megbízható helyi hálózathoz állítsd `GEAR_BIND=0.0.0.0` értékre, hozd újra létre a konténert, és használd a `http://SZERVER_IP:8187` címet. Régi verzió frissítésénél ezt külön állítsd be, ha meg akarod tartani a LAN-elérést. Közvetlenül ne tedd ki az internetre; távoli használathoz VPN vagy HTTPS reverse proxy és megfelelő hozzáférés-védelem szükséges. Egy közös jelszót kezel, nincs MFA vagy beépített próbálkozáskorlát.

A `GEAR_PORT` a gazdagép portja, a `GEAR_DATA_PATH` az adatokat tároló mappa (`./data`). A konténerben az adatkönyvtár `/data`, a belső port `8080`. A további beállítások az angol táblázatban szerepelnek.

### Frissítés és mentés

Frissítés előtt állítsd le az alkalmazást, és mentsd le a teljes adatkönyvtárat, beleértve az adatbázist, a feltöltéseket és a `session.key` fájlt. A fenti **Backups and restore** részben másolható parancsokat találsz. A CSV-export nem teljes biztonsági mentés: nem tartalmaz fájlokat, javítási eseményeket vagy auditnaplót.

Compose-os telepítés frissítése:

```bash
git pull --ff-only
docker compose up -d --build
```

**Build is kell; a régi image újraindítása nem telepíti a módosításokat.** Végül frissítsd a böngészőt, szükség esetén Ctrl+F5-tel. Az adatbázis kiegészítő frissítései induláskor lefutnak, a meglévő adatokat megőrzik.

TrueNAS SCALE Apps esetén az appot az **Apps** felületen kezeld. Leállítás és mentés után a repó tulajdonosának nevében futtasd a `git pull --ff-only` parancsot, majd buildeld a TrueNAS appban ténylegesen beállított image taget:

```bash
sudo docker build -t A_BEÁLLÍTOTT_IMAGE_TAG .
```

Ezután indítsd el az appot az Apps felületen. A meglévő gazdagépes adatmappa maradjon `/data` alá csatolva. Ne indíts mellé külön Compose-példányt. Visszaállítást kizárólag leállított alkalmazásnál végezz, a teljes adatmappával és a megfelelő jogosultságokkal.

### CSV és beszerzési mód

A **CSV import** ablakból üres sablont tölthetsz le. Kötelező oszlopok: `name`, `category`, `status`; a teljes fejléc az angol útmutatóban látható. UTF-8 kódolás, vessző/pontosvessző/tabulátor, legfeljebb **1 MB és 500 tétel**. A dátum `YYYY-MM-DD` vagy üres.

A kategóriákat, állapotokat és beszerzési módokat angolul vagy magyarul is megadhatod, a felület nyelvétől függetlenül. A hibákat és duplikátumokat az előnézet jelzi. Választhatsz teljes megszakítást vagy hibás sorok kihagyását. A meglévő tételeket nem írja felül; a duplikáció kulcsa a név + márka + modell. A `parent_name` egy már meglévő, egyértelmű nevű szülőeszközhöz kapcsol.

A beszerzési mód lehet **Vásárolt, Ajándék, Csere, Szívességért, Ingyen elvihető, Ismeretlen**. Hiányzó/üres értéknél Ismeretlen. **0 Ft nem jelent automatikusan ajándékot.** A régi tételek közös szerkesztéssel besorolhatók. A dashboard bontása a tulajdonban lévő eszközöket számolja; az összérték rögzített vételár, nem jelenlegi piaci becslés.

A **CSV export** az összes tételt letölti, az eladott/elajándékozott eszközöket is. Az oszlopnevek változatlanok, a kategória/állapot/beszerzés feliratai az aktuális nyelvet követik. A saját szövegek megmaradnak. Az export mindkét felületnyelven visszaimportálható, de a már meglévő tételeket duplikátumként jelzi. Az elavult kategóriákat előbb támogatott típusra kell cserélni. Üres adatbázisnál a szülőket a gyerekek előtt importáld.

### Fejlesztés és publikálás

Python 3.12+ szükséges, a backendhez nincs külső Python-csomag. A közvetlen indítás, a tesztparancsok és a fájlok szerepe az angol részben található. A tesztek átmeneti adatbázist használnak, a saját nyilvántartást nem módosítják. A `seed.py` kizárólag kitalált példaadatokat tartalmaz, és csak külön elindítva fut le.

A forrás kizárólag kitalált demo-adatokat tartalmaz. A saját adatbázist, feltöltéseket, `.env` fájlt, SSH-kulcsokat, session-kulcsot és mentéseket ne publikáld. A Git- és Docker-kizárások segítenek, de push előtt mindig ellenőrizd a követett fájlokat. A publikus forráskód nem jelenti azt, hogy az alkalmazást közvetlenül az internetre kellene kitenni.
