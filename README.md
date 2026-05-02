# Corruption Report Platform

Korruptsion holatlar bo'yicha anonim xabar berish web-platformasi.

## Imkoniyatlar

- Chiroyli web-forma
- Telefon raqam majburiy
- F.I.Sh, passport va boshqa shaxsiy maydonlar yo'q
- Rasm, video yoki PDF ilova qilish
- JSON database
- Admin panel
- Status o'zgartirish
- Ichki admin izoh
- CSV eksport
- Render.com uchun tayyor

## Lokal ishga tushirish

```bash
npm install
cp .env.example .env
npm start
```

Brauzerda oching:

```txt
http://localhost:3000
```

Admin panel:

```txt
http://localhost:3000/admin
```

Default `.env.example` bo'yicha:

```txt
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
```

## Render.com deploy

1. GitHub'da yangi repo oching.
2. Shu loyiha fayllarini repo ichiga yuklang.
3. Render.com → New → Web Service.
4. GitHub repo'ni tanlang.
5. Build Command:

```bash
npm install
```

6. Start Command:

```bash
npm start
```

7. Environment Variables qo'shing:

```txt
NODE_ENV=production
SESSION_SECRET=uzun-random-secret-yozing
ADMIN_USERNAME=admin
ADMIN_PASSWORD=kuchli-parol-yozing
DATABASE_PATH=./data/database.json
UPLOAD_DIR=./uploads
MAX_FILE_MB=100
MAX_FILES=5
```

## Muhim eslatma

Render free instance filesystem doimiy kafolatlanmaydi. Birinchi MVP uchun ishlaydi, lekin real foydalanishda fayllarni Cloudinary, Supabase Storage, S3 yoki Google Drive API orqali saqlash tavsiya qilinadi. Database uchun keyingi professional bosqichda Render PostgreSQL yoki Supabase PostgreSQL yaxshi variant.
