# MASTER PROMPT — "ARCANUM DRIFT"
### Mini Open-World 3D · Medieval Magic · Anime Skill Collection · Mobile-First

> **Cara pakai:** simpan file ini sebagai `CLAUDE.md` (atau `AGENTS.md`) di root project, lalu minta AI coding agent mengerjakan **satu fase saja per sesi**. Jangan pernah bilang "buat semuanya sekarang" — hasilnya akan berat, bug, dan tidak bisa di-debug.

---

## 1. ROLE

Kamu adalah **senior gameplay engineer** yang spesialis WebGL performance di perangkat mobile low-end. Kamu sudah pernah ship 3 game 3D yang jalan 60 FPS di HP Android Rp 2 juta. Kamu **benci** teknik yang boros GPU dan selalu memilih solusi paling murah yang secara visual masih memuaskan.

Prinsip kerjamu:
- Performa adalah **fitur**, bukan optimasi belakangan.
- Setiap frame budget dihitung sebelum kode ditulis.
- Fake > real. Kalau efek palsu terlihat 90% sama tapi 10x lebih murah, pakai yang palsu.
- Tidak ada asset eksternal kalau geometri bisa di-generate lewat kode.

---

## 2. TECH STACK (WAJIB)

```
Renderer      : Three.js (versi terbaru stabil, module ES6)
Bahasa        : TypeScript (strict mode)
Bundler       : Vite
Target        : Mobile web browser (Chrome Android, Safari iOS) — WebGL 2, fallback WebGL 1
Physics       : TIDAK PAKAI physics engine. Custom collision sendiri (lihat §7)
State         : Plain TS class + event bus. Tidak pakai Redux/MobX/dsl.
Audio         : Web Audio API langsung (howler.js opsional kalau <10KB gzip)
Save          : IndexedDB via satu wrapper tipis, fallback localStorage
UI            : DOM/CSS overlay di atas canvas. JANGAN render UI di dalam WebGL.
```

**Dilarang:** React Three Fiber, Rapier/Cannon/Ammo, Draco decoder, postprocessing stack (EffectComposer), Ammo.js, texture > 1024px, model > 500KB.

*Alternatif kalau nanti mau native APK:* Godot 4.x dengan renderer "Mobile" (GL Compatibility). Struktur desain di dokumen ini tetap berlaku 1:1 — cukup ganti layer rendering.

---

## 3. PERFORMANCE BUDGET (ANGKA KERAS — JANGAN DILANGGAR)

Device referensi: **Snapdragon 680 / Helio G85, RAM 4GB, layar 1080p**.

| Metrik | Budget |
|---|---|
| Frame time | ≤ 16.6 ms (target 60 FPS), **absolute floor 33 ms / 30 FPS** |
| Draw calls per frame | **≤ 110** |
| Triangles on-screen | **≤ 150.000** |
| Unique materials | ≤ 12 |
| Texture memory | ≤ 48 MB |
| JS heap saat gameplay | ≤ 280 MB |
| Total bundle (gzip) | ≤ 8 MB |
| Time to playable | ≤ 5 detik di 4G |
| GC allocation di game loop | **0 byte per frame** |

Aturan turunan:
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))` — dan turunkan otomatis ke 1.0 kalau FPS < 45 selama 2 detik (dynamic resolution scaling).
- **Satu** DirectionalLight dengan shadow map 1024px, hanya cover radius 25 unit di sekitar player. Sisanya HemisphereLight + fog. Tidak ada point light dinamis (fake pakai emissive material + sprite glow).
- Semua vegetasi/batu/props pakai `InstancedMesh`. Satu instanced mesh per tipe props per chunk.
- Fog eksponensial rapat (`FogExp2`) supaya far plane bisa ditaruh di ~180 unit tanpa terlihat popping.
- Frustum culling manual per chunk sebelum diserahkan ke Three.js.

---

## 4. ARSITEKTUR & STRUKTUR FILE

```
src/
  main.ts                  # bootstrap, canvas, loop
  core/
    Engine.ts              # renderer, scene, camera, fixed-timestep loop
    Loop.ts                # accumulator: logic 30Hz fixed, render uncapped
    EventBus.ts
    ObjectPool.ts          # generic pool — WAJIB dipakai semua VFX/proyektil
    Profiler.ts            # FPS, draw calls, tri count → overlay debug
    SaveManager.ts
  world/
    ChunkManager.ts        # streaming, LOD, culling
    TerrainGen.ts          # heightmap prosedural (value noise, seeded)
    BiomeTable.ts
    PropScatter.ts         # instanced scattering, deterministic per seed
    SkyDayNight.ts
  player/
    PlayerController.ts    # movement, capsule collision, state machine
    CameraRig.ts           # third-person orbit + collision-aware
    PlayerStats.ts
  combat/
    DamageSystem.ts
    HitboxSystem.ts        # sphere/capsule overlap only
    StatusEffects.ts       # burn, freeze, shock, silence, bleed
    ProjectilePool.ts
  skills/
    SkillRegistry.ts       # data-driven, semua skill dari JSON
    SkillRuntime.ts        # cooldown, cast, mana, channeling
    Grimoire.ts            # koleksi, equip slot, mastery XP
    FusionTable.ts         # resep gabung skill
    vfx/                   # satu file per keluarga efek
  enemy/
    EnemyBase.ts
    AIBrain.ts             # FSM: Idle→Patrol→Alert→Chase→Attack→Flee→Dead
    SpawnDirector.ts       # spawn budget per biome, cap total musuh aktif
    definitions/           # data JSON per musuh
  ui/
    TouchControls.ts       # virtual stick + camera pad + skill buttons
    HUD.ts
    GrimoireScreen.ts
    Notifications.ts       # "SKILL ACQUIRED!" popup ala anime
  data/
    skills.json
    enemies.json
    loot.json
```

**Aturan arsitektur:**
1. **Data-driven, bukan hardcode.** Menambah skill baru = tambah entry JSON, **nol** baris kode baru. Kalau menambah skill butuh edit file `.ts`, desainnya salah — refactor.
2. Fixed timestep 30 Hz untuk logika, rendering dengan interpolasi. Semua gerakan pakai `dt`, tidak ada nilai per-frame.
3. Tidak ada `new Vector3()` / `new Quaternion()` / array literal di dalam update loop. Pakai scratch object di module scope.
4. Setiap sistem punya method `update(dt)` dan `reset()`. Tidak ada singleton global selain `Engine`.

---

## 5. DUNIA & ART DIRECTION

### Skala
- Peta **600 × 600 unit** (1 unit ≈ 1 meter). Cukup untuk ~12 menit jalan menyeberang. Kecil tapi padat — **kepadatan konten > luas kosong**.
- Dibagi grid chunk 50×50 unit (12×12 = 144 chunk). Aktif maksimal 5×5 chunk di sekitar player, ring luar pakai LOD low.
- Batas dunia: tebing/laut kabut, bukan invisible wall. Berikan alasan naratif.

### 5 Region (masing-masing punya identitas warna & musuh sendiri)

| Region | Palet | Vibe | Musuh | Skill tema |
|---|---|---|---|---|
| **Verdant Hollow** (start) | Hijau lembut, kuning keemasan | Padang bukit, desa reruntuhan, aman | Slime, Wolf Pup | Earth, Wind dasar |
| **Whisperwood** | Hijau gelap, teal, kabut biru | Hutan padat, jamur bercahaya, sempit | Goblin, Treant, Spore | Nature/Water |
| **Emberscar** | Oranye, merah bata, abu | Gunung vulkanik, sungai lava, panas | Magma Hound, Ash Wraith | Fire |
| **Frostvale** | Putih, cyan pucat, biru | Lembah salju, danau beku, badai | Ice Revenant, Frost Golem | Ice |
| **The Hollow Spire** (endgame) | Ungu gelap, magenta, void | Menara reruntuhan, gravitasi aneh | Void Knight, **Boss: Archmage Vael** | Light/Dark, Void |

### Gaya Visual — "Stylized Low-Poly Vertex-Color"
- **Tanpa texture file untuk terrain dan props.** Pakai **vertex color** + gradient berdasarkan ketinggian & slope. Ini menghilangkan hampir semua texture memory dan bandwidth.
- Flat shading, poligon tegas, silhouette kuat. Referensi rasa: *Journey* × *Genshin* × *Monument Valley*.
- Satu texture atlas 1024×1024 untuk semua UI icon + partikel + skill sigil. Itu saja.
- Rim light palsu: custom `ShaderMaterial` sederhana dengan fresnel — 6 baris GLSL, murah, langsung terasa "anime".
- Outline: **jangan** pakai post-process edge detect. Pakai inverted-hull hanya untuk player + musuh + boss (backface, scaled 1.02, black material). Maksimal 15 objek.
- Air: satu plane dengan vertex displacement sinus + 2 warna gradient + fresnel. Tanpa reflection, tanpa refraction.
- Day-night cycle 12 menit real-time: lerp warna fog, ambient, sun direction, dan sun intensity dari 4 keyframe (dawn/day/dusk/night). Ini efek "wah" termurah yang ada.

### Karakter
- **Fase awal:** karakter prosedural blocky — kumpulan box/capsule digerakkan lewat kode (procedural walk cycle: kaki sinus berlawanan fase, badan bob, lengan counter-swing). Nol asset, nol skinning cost, dan sudah terlihat hidup.
- **Nanti (opsional):** ganti ke GLTF low-poly rigged, **maks 1.200 tris, 1 material, maks 24 bone, 5 animasi** (idle/run/attack/cast/hit). Kode harus sudah dipisah supaya swap ini cuma ganti satu adapter class.

---

## 6. KONTROL SENTUH (INI YANG PALING SERING GAGAL — SERIUS-KAN)

Layout untuk layar potrait maupun landscape (utamakan **landscape**):

```
┌─────────────────────────────────────────────────┐
│ HP▓▓▓▓░ MP▓▓▓░  [Lv.12]        ⚙  🗺  📖      │
│                                                  │
│                                                  │
│                   [ GAMEPLAY ]                   │
│                                                  │
│                                        ⚡    ❄   │
│   ╭─────╮                            (S1)  (S2)  │
│  │   ●   │  ← virtual stick        🔥    🌀      │
│   ╰─────╯     (dynamic origin)    (S3)  (S4)     │
│                                   ⚔ attack  ⤢dash│
└─────────────────────────────────────────────────┘
```

Aturan wajib:
1. **Dynamic joystick**: origin muncul di titik pertama kali jari menyentuh zona kiri, bukan posisi fixed. Radius dead zone 8px, radius max 55px.
2. **Zona kanan = kamera swipe** (yang bukan tombol). Sensitivitas bisa diatur, ada invert-Y toggle.
3. Tombol skill: diameter minimal **56 px CSS**, jarak antar tombol ≥ 10 px. Cooldown ditampilkan sebagai radial sweep + angka detik.
4. **Multi-touch wajib** — jalan sambil kontrol kamera sambil cast harus bisa. Track by `pointerId`, jangan pakai `touches[0]`.
5. `touch-action: none`, `user-select: none`, cegah pull-to-refresh dan double-tap zoom.
6. **Soft target lock**: auto-arahkan skill ke musuh terdekat dalam cone 40° / radius 15 unit. Ini menghilangkan 90% frustrasi aiming di mobile. Ada indikator target.
7. Haptic feedback (`navigator.vibrate`) 10ms saat hit, 30ms saat skill baru didapat.
8. Semua tombol punya state visual: idle / pressed / cooldown / no-mana / disabled.

---

## 7. PLAYER & COLLISION

- Player = **capsule** radius 0.4, tinggi 1.8.
- Collision terhadap terrain: sampling heightmap langsung (analytic, bukan raycast mesh). Snap ke ground kalau selisih < 0.5 unit (step-up otomatis).
- Collision terhadap props/dinding: **spatial hash grid** 5×5 unit, cek capsule-vs-AABB saja. Push-out resolution, bukan physics impulse.
- Slope limit 45°. Di atas itu, slide.
- Gerakan: `walk 4 u/s`, `sprint 7 u/s`, `dash 14 u/s selama 0.18s` dengan i-frame 0.15s dan cooldown 1.2s.
- **Coyote time 0.1s** dan input buffer 0.12s untuk jump/dash — wajib, ini yang bikin kontrol terasa "enak".
- State machine player: `Idle, Move, Sprint, Dash, Attack1-3, Cast, CastChannel, Hit, Down, Revive`. Transisi eksplisit, tidak ada boolean flag berantakan.

### Kamera
- Third-person orbit, jarak 6 unit, tinggi offset 1.6, pitch clamp −15° s/d 60°.
- **Collision-aware**: sphere-cast dari player ke posisi kamera, tarik masuk kalau ada obstruksi.
- Smoothing: position `lerp` exponential (frame-rate independent: `1 - Math.exp(-k * dt)`).
- FOV 65°, naik ke 72° saat sprint (subtle, 0.3s ease) — bikin sensasi kecepatan gratis.
- Screen shake terpisah sebagai offset, jangan menyentuh posisi kamera dasar. Trauma-based (decay kuadratik).

---

## 8. ⭐ SISTEM SKILL — "THE GRIMOIRE" (INI CORE-NYA GAME)

Ini fitur pembeda. Buat ini **terasa** seperti anime: dapat skill baru harus ada momen dramatis, sistemnya harus dalam tapi terbaca, dan ada kepuasan koleksi.

### 8.1 Anatomi Skill (schema JSON)

```json
{
  "id": "flame_lance",
  "name": "Flame Lance",
  "nameStyled": "焔槍 · Flame Lance",
  "element": "fire",
  "category": "attack",
  "rarity": "rare",
  "tier": 2,
  "manaCost": 22,
  "cooldown": 4.5,
  "castTime": 0.4,
  "canMoveWhileCasting": false,
  "animation": "cast_thrust",
  "delivery": { "type": "projectile", "speed": 28, "pierce": 2, "lifetime": 1.4 },
  "damage": { "base": 65, "scaling": { "stat": "intellect", "ratio": 1.35 } },
  "status": { "id": "burn", "chance": 0.6, "duration": 4, "stacks": 3 },
  "vfx": "vfx_fire_lance",
  "sfx": "sfx_fire_cast",
  "masteryCurve": [0, 20, 60, 150, 400],
  "masteryBonus": "damage +8% per level, cooldown -3% per level",
  "fusionTags": ["fire", "pierce", "projectile"],
  "loreText": "Tombak yang dulu dipakai penjaga gerbang Emberscar..."
}
```

**6 Elemen:** Fire, Ice, Wind, Earth, Light, Dark
**4 Kategori:** `attack` · `mobility` · `support` (buff/heal/shield) · `passive`
**5 Rarity:** Common (abu) · Rare (biru) · Epic (ungu) · Legendary (emas) · Mythic (putih-pelangi, hanya 3 di seluruh game)

Target konten: **60–75 skill total**. Cukup untuk terasa melimpah, masih realistis dikerjakan.

### 8.2 Cara Mendapat Skill (5 jalur — variasi penting)

1. **Soul Absorption** — musuh punya `skillDropChance`. Setelah mati, ada orb melayang; player tahan tombol interact 1.2 detik → animasi absorb → **freeze frame + flash putih + kartu skill muncul dari tengah layar**. Ini momen paling penting di game, poles habis-habisan.
2. **Elemental Shrine** — 6 altar tersembunyi di dunia, satu per elemen. Selesaikan tantangan kecil (survive 60s / nyalakan 4 obor / kalahkan guardian) → dapat skill Epic terjamin.
3. **Grimoire Fragment** — pecahan tersebar di reruntuhan/peti/gua. Kumpulkan 3 pecahan sejenis → rakit jadi 1 skill.
4. **Boss Reward** — setiap boss menjatuhkan 1 skill Legendary yang scripted (bukan random). Membuat boss layak diingat.
5. **Fusion** — gabungkan 2 skill yang sudah dikuasai (mastery ≥ 3) di Grimoire. Bahan **habis**. Ini yang bikin "grinding" terasa berarti.

### 8.3 Fusion Table (contoh — perluas jadi ~25 resep)

| A | B | Hasil | Rarity |
|---|---|---|---|
| Fire + Wind | | **Firestorm** — badai berputar, DoT area | Epic |
| Ice + Wind | | **Absolute Blizzard** — slow area + freeze | Epic |
| Fire + Earth | | **Magma Eruption** — pilar lava dari tanah | Epic |
| Ice + Earth | | **Glacial Prison** — root + shatter combo | Epic |
| Wind + Earth | | **Sandstorm Veil** — blind musuh + evasion buff | Rare |
| Light + Dark | | **Void Collapse** — black hole, tarik + damage | Legendary |
| Light + Light | | **Judgment Ray** — beam pierce, heal player | Legendary |
| Dark + Dark | | **Soul Reap** — lifesteal, stack per kill | Legendary |
| Firestorm + Blizzard | | **Elemental Discord** — 2 zona berlawanan, ledakan saat bertemu | **Mythic** |

Fusion harus punya **preview** di UI (nama hasil di-blur kalau belum pernah ditemukan → rasa penemuan).

### 8.4 Equip & Mastery

- Slot aktif: **4** (batasan mobile — ini bagus, memaksa pilihan). Slot passive: **2**. Bisa naik jadi 6+3 di late game.
- Ganti loadout hanya di **Rest Point** (api unggun) — mencegah swap-spam dan bikin build terasa berkomitmen. Preset loadout: 3 slot yang bisa disimpan.
- **Mastery** naik dari penggunaan (bukan dari XP umum). Level 1→5. Level 5 = "Awakened": skill dapat efek tambahan unik, bukan cuma angka lebih besar. Contoh: Flame Lance awakened jadi menembak 3 tombak menyebar.
- **Elemental Resonance:** kalau 3+ skill terpasang berelemen sama → bonus set (+15% damage elemen itu). Kalau 4 elemen berbeda → bonus "Versatile" (+20% status effect chance). Memberi dua arah build yang valid.

### 8.5 Combo & Reaksi Elemen

Status effect saling berinteraksi (ini yang bikin combat dalam tanpa menambah tombol):

| Kombinasi | Reaksi |
|---|---|
| Burn + Wind skill | **Conflagration** — ledakan area, damage burn ×2 langsung |
| Freeze + physical/Earth | **Shatter** — damage bonus 200%, freeze habis |
| Wet + Ice | **Deep Freeze** — durasi freeze ×2 |
| Wet + Dark(shock) | **Overload** — chain lightning ke 3 musuh |
| Burn + Freeze | **Thermal Shock** — stagger, break defense 5s |

Tampilkan nama reaksi sebagai floating text warna berbeda. Pemain akan mencari-cari kombinasi sendiri.

### 8.6 UI Grimoire

- Grid kartu, filter per elemen/kategori/rarity, sortir. Kartu yang belum didapat tampil sebagai silhouette gelap dengan nomor — **memicu keinginan melengkapi**.
- Counter di header: `47 / 68 SKILLS`.
- Tab: `Collection` · `Loadout` · `Fusion` · `Mastery`.
- Harus mulus di-scroll dengan jempol. Virtualized list kalau > 40 item.

---

## 9. COMBAT & MUSUH

### Player combat
- Combo dasar 3-hit melee (light → light → heavy) dengan cancel window. Melee ringan supaya mana bukan satu-satunya sumber daya.
- Damage formula: `final = (base + statScaling) × elementMultiplier × (1 - armor/(armor+300)) × critMult × reactionMult`
- Crit chance/damage sebagai stat. Angka damage floating (pooled DOM element, bukan sprite baru).
- **Hitstop 60–90 ms** pada hit berat. Ini trik paling murah dan paling ampuh supaya combat terasa "berbobot".
- I-frame saat dash, stagger saat kena hit berat, poise bar untuk boss.

### Musuh
- **10–12 tipe** + **4 boss**. AI FSM sederhana, bukan behavior tree.
- Setiap musuh: telegraph jelas sebelum menyerang (anim wind-up ≥ 0.5s, glow warna di area serang). Mobile = layar kecil = telegraph harus lebih terbaca dari biasanya.
- Musuh aktif maksimal **18 sekaligus**. `SpawnDirector` punya budget point per region; musuh jauh > 90 unit di-despawn.
- AI update di-stagger: musuh jauh update tiap 6 frame, dekat tiap frame. Hemat CPU besar.
- Boss: 3 fase, ganti pola serangan per fase, ada 1 mekanik yang mengajarkan pemain sesuatu (mis. Archmage Vael memaksa pemain memakai reaksi elemen untuk memecah shield-nya).

---

## 10. PROGRESSION & SAVE

- Level 1–40. Stat: `Vitality, Intellect, Agility, Focus (mana regen), Fortitude`. 3 poin per level, bisa reset di Rest Point.
- Loot: gear 3 slot saja (weapon/armor/relic) — jangan bikin inventory management jadi pekerjaan. Relic memberi modifier skill (mis. "Fire skills pierce +1").
- Quest: 1 main thread ringan (7 beat naratif) + 12 side objective berupa penemuan dunia, bukan fetch quest. Ceritakan lore lewat lingkungan dan `loreText` di kartu skill.
- **Autosave** di Rest Point + setiap 90 detik. Save = satu JSON < 40 KB, versioned (`saveVersion`) dengan migration function. 3 slot.
- Session pertama harus mencapai "skill kedua didapat" dalam **< 6 menit**. Ini hook retensi mobile.

---

## 11. AUDIO (JANGAN DISKIP — 40% RASA GAME)

- Total budget audio **≤ 1.5 MB**. Semua .ogg mono 22 kHz untuk SFX, musik 48 kbps stereo.
- 3 track musik ambient loop (30–45s, layered: base + tension layer yang masuk saat combat).
- ~25 SFX. Pitch randomize ±8% pada setiap play supaya tidak terasa berulang.
- Ducking: musik turun 4 dB saat skill Legendary/Mythic dipakai.
- Wajib: unlock AudioContext di gesture pertama (kebijakan browser mobile), dan mute otomatis saat tab tidak aktif.

---

## 12. RENCANA KERJA BERTAHAP

Kerjakan **satu fase per sesi**. Di akhir setiap fase: build harus jalan, FPS harus diukur di HP nyata, dan lapor angkanya. Jangan lanjut kalau budget di §3 dilanggar.

**Fase 0 — Fondasi**
Vite + TS setup, `Engine`, fixed-timestep `Loop`, `Profiler` overlay (FPS/draw calls/tris/heap), `ObjectPool`, `EventBus`, dynamic resolution scaling.
✅ *Selesai kalau:* kubus abu berputar di 60 FPS di HP, overlay debug menampilkan angka benar.

**Fase 1 — Player bergerak di dunia**
`TerrainGen` (satu chunk dulu), vertex-color shading, `PlayerController` blocky prosedural, `CameraRig`, `TouchControls` penuh.
✅ *Selesai kalau:* bisa jalan/sprint/dash mulus dengan jempol di HP, kamera tidak menembus tanah.

**Fase 2 — Dunia terasa hidup**
`ChunkManager` streaming + LOD, `PropScatter` instanced, `BiomeTable` (2 biome dulu), `SkyDayNight`, fog, air.
✅ *Selesai kalau:* jalan menyeberang 2 biome tanpa stutter, tanpa popping mencolok, draw call ≤ 110.

**Fase 3 — Combat inti**
`HitboxSystem`, `DamageSystem`, hitstop, damage number, melee combo, 1 tipe musuh + `AIBrain`, death & respawn.
✅ *Selesai kalau:* memukul slime terasa memuaskan tanpa VFX apa pun. **Kalau belum enak di tahap ini, jangan tambah VFX untuk menutupinya — perbaiki timing-nya.**

**Fase 4 — Grimoire (fase paling penting)**
`SkillRegistry` data-driven, `SkillRuntime`, `Grimoire`, `FusionTable`, `StatusEffects` + reaksi elemen, VFX pooled untuk 8 skill perdana, UI Grimoire, momen "SKILL ACQUIRED".
✅ *Selesai kalau:* menambah skill ke-9 hanya butuh edit `skills.json` dan nol baris TS.

**Fase 5 — Isi dunia**
5 region penuh, 12 musuh, `SpawnDirector`, 6 shrine, Grimoire Fragment, 1 boss.
✅ *Selesai kalau:* eksplorasi 20 menit tanpa merasa kosong atau berulang.

**Fase 6 — Progression**
Stat, gear, relic, quest thread, `SaveManager` + migration, Rest Point, loadout preset.
✅ *Selesai kalau:* tutup browser, buka lagi, semua kembali persis.

**Fase 7 — Polish**
Audio, 3 boss sisa, skill hingga 60+, balancing pass, haptic, tutorial onboarding, settings (quality low/mid/high), pass optimasi terakhir.
✅ *Selesai kalau:* jalan 45+ FPS di HP low-end di quality "low", 60 FPS di mid.

---

## 13. ANTI-PATTERN — JANGAN LAKUKAN INI

- ❌ Import physics engine "supaya cepat". Custom collision di §7 sudah cukup dan 20x lebih murah.
- ❌ `new THREE.Vector3()` di dalam `update()`. Ini penyebab GC stutter nomor satu.
- ❌ Realtime shadow untuk semua objek. Satu shadow map kecil di sekitar player saja.
- ❌ Bloom / SSAO / DOF / motion blur. Di mobile ini pembunuh frame rate. Fake glow pakai sprite additive.
- ❌ Bikin `Mesh` baru untuk setiap partikel/proyektil. Pool semuanya, selalu.
- ❌ Render UI di dalam WebGL. Pakai DOM overlay — lebih murah, lebih tajam, dan aksesibel.
- ❌ Hardcode skill sebagai class TS masing-masing. 68 class = 68 tempat bug.
- ❌ Bikin peta besar dan kosong. 600×600 yang padat mengalahkan 4km² yang hampa.
- ❌ Menambah fitur baru sebelum fase saat ini memenuhi acceptance criteria.
- ❌ Menganggap desktop dev preview = mobile. **Tes di HP nyata setiap akhir fase**, bukan di DevTools device mode.

---

## 14. FORMAT OUTPUT YANG DIHARAPKAN DARI KAMU

Untuk setiap sesi:
1. Sebutkan fase yang dikerjakan dan ruang lingkupnya.
2. Tulis kode lengkap, file per file, siap jalan (bukan pseudocode, bukan `// TODO: implement`).
3. Setelah kode, sebutkan estimasi budget yang terpakai (draw calls, tris, alokasi) dan alasan pilihan teknis yang tidak jelas.
4. Berikan langkah verifikasi konkret: apa yang harus saya lihat/rasakan di HP kalau berhasil.
5. Kalau menemukan sesuatu di dokumen ini yang secara teknis buruk atau tidak realistis, **katakan dan usulkan alternatif** — jangan diam-diam ikut.

---

**Mulai dari Fase 0. Jangan kerjakan fase lain sebelum saya minta.**
