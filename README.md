# MoniMobiApp

Sisitemu y'imihigo n'ibikorwa byo gukangurira, kugenzura no gukurikirana mu Murenge wa Cyuve, Musanze.

## Ibyo ikora

- Abakozi binjira muri konti zabo bagakora raporo, bakabona raporo z'abandi bakozi; buri mukozi ahindura cyangwa agasiba izo yakoze gusa.
- Admin areba, ahindura cyangwa agasiba raporo zose, akora konti z'abakozi, ashobora guhagarika cyangwa kongera gufungura konti.
- Impinduka ku zindi raporo zigaragara ku bandi nyuma y'igihe gito (urupapuro ruhita rusubiramo urutonde buri masegonda 15).
- Raporo zibikwa muri SQLite kuri server. GitHub private ibika kopi ya SQLite **isobanuwe (encrypted)**; iyo server itangiye, isubiza kopi iheruka.
- Backup nshya itegurwa amasegonda 15 nyuma y'impinduka. Iyo backup yanze, server irongera ikagerageza nyuma y'umunota.
- Health check ya UptimeRobot: `/api/health`.
- Amakuru y'imihigo n'ibikorwa biva muri sheets 5 za Excel V3: imihigo 103, ibikorwa 173, utugari 6, imidugudu 40, n'amabwiriza.
- Raporo imwe ishobora kugira imihigo myinshi. Kuri buri muhigo umukozi ahitamo icyiciro n'umuhigo, akandika abagenerwabikorwa/abafatanyabikorwa benshi, akagena Akagari n'Umudugudu.
- GROUP II ibika abantu bakoze igikorwa (amazina, inshingano, telephone n'umukono) kandi yemera kongeramo benshi.
- GROUP III yuzuzwa umuhigo umwe umwe. Ibibazo bihinduka bitewe na Sensitization/Ubukangurambaga, Monitoring/Ubugenzuzi cyangwa Follow-up/Gusubira gusura.
- Raporo za kera zifite imiterere y'umuhigo umwe ziracyafunguka; iyo zibitswe mu miterere mishya zihuzwa n'umuhigo umwe kugira ngo amakuru yazo atazimira.
- Word report ikora urutonde rw'imihigo yose, location n'abagenerwabikorwa kuri buri muhigo, urutonde rw'abakoze igikorwa, n'imbonerahamwe y'amakuru yihariye kuri buri muhigo.

## Gutangiza kuri mudasobwa

1. Shyiraho Node.js 22.13 cyangwa iyisumbuyeho.
2. Kora `npm install`.
3. Kora admin wa mbere ukoresheje `npm run create-admin`; password igomba kugira inyuguti 12 nibura.
4. Kora `npm start`, hanyuma ufungure `http://localhost:3000`.

Iyo `GH_DATA_TOKEN` na `GH_DATA_REPO` bitashyizweho, server yo kuri mudasobwa ikoresha SQLite yo muri `data/` gusa. Ntukoreshe mudasobwa ebyiri nk'aho ari server imwe.

## Gushyira kuri Render Free

### 1. GitHub private repository y'amakuru

Kora repository nshya yitwa `monimobi-data` kuri GitHub, uyigire **Private**, wongeremo README kugira ngo ishobore kwakira backup. Iyi repository ni iy'iyi app; ntuyivange na repository ya code ya MoniMobiApp cyangwa iya VETLINK.

Kora Fine-grained Personal Access Token:

- Repository access: **Only select repositories** → `monimobi-data`.
- Repository permissions: **Contents: Read and write**.
- Ntushyire token muri source code cyangwa muri `render.yaml`.

Amadosiye ya backup abikwa encrypted mbere yo koherezwa. Key yayo ijya muri Render secrets gusa. Komeza kurinda uburenganzira kuri GitHub private repo n'iyo backup yaba encrypted.

### 2. Render

Kora Blueprint nshya uhitemo repository ya MoniMobiApp; `render.yaml` izashyiraho Node web service. Muri Environment ya service, shyiramo:

| Environment variable | Icyo ishyirwamo |
| --- | --- |
| `JWT_SECRET` | Ijambo ry'ibanga rirerire kandi ridasubirwamo |
| `GH_DATA_TOKEN` | Fine-grained token yo hejuru |
| `GH_DATA_REPO` | `sarocyuve-beep/monimobi-data` (hindura owner niba bitandukanye) |
| `GH_DATA_ENCRYPTION_KEY` | Random key y'inyuguti 64 za hexadecimal |
| `ADMIN_USERNAME` | Username ya admin wa mbere |
| `ADMIN_PASSWORD` | Password y'agateganyo, inyuguti 12 nibura |
| `ADMIN_FULL_NAME` | Amazina ya admin wa mbere |

Kora secret ebyiri kuri mudasobwa yawe ukoresheje:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Iya mbere ni `JWT_SECRET`; iya kabiri ni `GH_DATA_ENCRYPTION_KEY`. Zibike muri password manager, kandi ntuzishyire muri repo. Server izanga gutangira muri production niba GitHub backup cyangwa secret bibura. Admin wa mbere ahabwa guhindura password igihe yinjiye bwa mbere.

### 3. UptimeRobot

Nyuma y'uko Render itanze public URL, kora HTTP(s) monitor ya:

```text
https://IZINA-RYA-APP.onrender.com/api/health
```

Hitamo kugenzura buri minota 5. UptimeRobot igenzura ko service isubiza HTTP; **ntibika raporo** kandi ntihindura backup. Render Free ishobora gusinzira cyangwa igahagarikwa n'ibindi bihe; UptimeRobot ntitanga garanti ya 24/7. Genzura monthly instance hours kuko Free workspace ihabwa amasaha 750 ku kwezi.

## Uburenganzira n'umutekano

- Nta kwiyandikisha kw'abantu bose: admin akora konti z'abakozi.
- Abakozi bose babona raporo zose, ariko bahindura cyangwa bagasiba izo bakoze gusa; admin abona kandi agenzura raporo zose.
- Password zibikwa nka bcrypt hash. Konti nshya ihatirwa guhindura password ya mbere; kwinjira bibikwa muri `sessionStorage` kandi kurangira nyuma y'amasaha 12.
- GitHub backup ikoresha AES-256-GCM; token na encryption key biri muri Render environment gusa.
- SQLite ya Render Free iri kuri disk y'agateganyo; database ibikwa muri backup ya GitHub ikagarurwa server itangiye. Backup ikorwa nyuma y'amasegonda 15, bityo impinduka za nyuma zishobora kubura server iguye mbere y'uko backup irangira.
- GitHub private repo ibika commit nshya kuri backup; kora igenzura rya backup buri gihe kandi ntukoreshe ubu buryo nk'ububiko bwa production budafite indi backup.

## Tests

Koresha `npm test` kugenzura kwinjira, uburenganzira bwo kureba raporo, kwirinda kwandika hejuru y'impinduka nshya, n'ubuyobozi bwa konti.
