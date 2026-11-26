# MoniMobi kuri phone (APK na PWA)

APK ya MoniMobi ni «umwenda» wa Android ufungura app yawe iri kuri Render (WebView). Rero **igomba internet**, kandi impinduka zose ukoze kuri app (urugero ibyitegererezo) zigaragara ako kanya nta kongera gukora APK.

## Uburyo 1 — Kuyishyira kuri phone nta APK (PWA, byihuse)

1. Fungura aderesi ya app muri Chrome kuri phone.
2. Kanda buto «📲 Shyira kuri phone» (iyo igaragara), cyangwa menu ya Chrome (⋮) → **Install app / Add to Home screen**.

## Uburyo 2 — Gukora APK ukoresheje GitHub (bisabwa, nta kintu ushyira kuri computer)

1. Shyira umushinga wose kuri GitHub (harimo `mobile/` na `.github/`).
2. Kuri GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable**
   - Izina: `APP_URL`
   - Agaciro: aderesi ya app yawe kuri Render, urugero `https://monimobi-app.onrender.com` (igomba gutangira na `https://`).
3. Jya kuri **Actions → Build Android APK → Run workflow**. (Ushobora no kwandika URL aho mu kazu «app_url».)
4. Nyuma y'iminota nka 5–10, fungura iyo run, manura **MoniMobi-apk** (zip irimo `app-debug.apk`).
5. Ohereza `app-debug.apk` kuri phone (WhatsApp, USB, Drive...), uyifungure, wemere «Install unknown apps» niba bibajijwe.

## Uburyo 3 — Gukora APK kuri computer yawe

Ukeneye: Node.js 20, JDK 17, na Android Studio (ifite Android SDK).

```
cd mobile
npm install
set APP_URL=https://monimobi-app.onrender.com      (Windows PowerShell: $env:APP_URL="https://...")
npm run configure
npm run add-android
npx cap sync android
cd android
gradlew.bat assembleDebug                           (Mac/Linux: ./gradlew assembleDebug)
```

APK iboneka muri `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

## Ibyo kumenya

- **Render ya "free" irasinzira** iyo hashize igihe nta muntu uyikoresha; gufungura bwa mbere bishobora gufata ikiminota.
- Iyo nta internet, app yerekana urupapuro «Nta murandasi» rufite buto yo kongera kugerageza.
- Kuri APK, buto ya **Word (.docx)** ifungura urutonde rwa «Share» rwa Android (kubika muri Files, WhatsApp, Gmail...), kuko Android WebView idashobora kumanura dosiye zisanzwe.
- Iyi ni **debug APK** (ikora neza ku bakozi bawe, ariko si iya Play Store). Kuyishyira kuri Play Store hakenewe «release signing key».
- Niba uhinduye aderesi ya app kuri Render, ongera ukore APK ukoresheje URL nshya.
- **Camera:** ubwa mbere ukanze «📷 Fata ifoto» muri APK, Android irabaza uburenganzira bwa camera — emera. «🖼️ Hitamo muri gallery» ntisaba uburenganzira bwihariye.
