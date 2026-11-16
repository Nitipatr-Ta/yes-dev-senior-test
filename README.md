# Ultra-Resort Booking Engine

ระบบ API สำหรับจองห้องพัก "The Royal Hideaway" ที่รองรับการจองพร้อมกันจำนวนมากโดยไม่เกิด Overbooking พร้อม Dynamic Pricing และ Dashboard แบบ real-time

## Stack

| ส่วน | เทคโนโลยี |
|---|---|
| API | Node.js 24, TypeScript, Fastify |
| Database | PostgreSQL 17 |
| Cache / Lock / Rate limit | Redis 7 |
| Test | Vitest |
| Runtime | Docker Compose |

## วิธีติดตั้งและรัน

ต้องมี Docker และ Docker Compose

```bash
docker-compose up --build
```

API จะเปิดที่ `http://localhost:3000` ตรวจสถานะได้ที่ `GET /health`

เมื่อ API เริ่มทำงานจะรันไฟล์ใน `migrations/` ตามลำดับชื่อโดยอัตโนมัติ (สร้างตารางและข้อมูลห้องตั้งต้น) และบันทึกไฟล์ที่รันแล้วไว้ในตาราง `schema_migrations`

ค่าเริ่มต้นใน `docker-compose.yml` ใช้สำหรับ local development เท่านั้น หากต้องการเปลี่ยนพอร์ต รหัสผ่านฐานข้อมูล `JWT_SECRET` บัญชี admin หรือปิด rate limit (`RATE_LIMIT_ENABLED=false`) ให้คัดลอก `.env.example` เป็น `.env` แล้วแก้ค่า

เมื่อเริ่มทำงาน API จะสร้างบัญชี admin จาก `ADMIN_EMAIL` และ `ADMIN_PASSWORD` หากยังไม่มีผู้ใช้อีเมลนั้น ค่าเริ่มต้นคือ `admin@example.com` / `admin_local_dev`

PostgreSQL ตั้งรหัสผ่านเฉพาะตอนสร้าง volume ครั้งแรก หากเปลี่ยน `POSTGRES_PASSWORD` หลังจากรันไปแล้ว API จะต่อฐานข้อมูลไม่ได้ (error `28P01`) ให้ลบ volume แล้วรันใหม่

```bash
docker-compose down -v
docker-compose up --build
```

### รันเทสต์

เทสต์ต่อกับ PostgreSQL และ Redis จริง จึงต้องเปิด container ไว้ก่อน รหัสผ่านใน `DATABASE_URL` ต้องตรงกับที่ container ใช้ (`booking_local_dev` เมื่อไม่มีไฟล์ `.env`)

```bash
npm install
DATABASE_URL=postgres://booking:booking_local_dev@localhost:5432/booking REDIS_URL=redis://localhost:6379 npm test
```

## สถานะงาน

| ส่วน | สถานะ |
|---|---|
| โครงโปรเจกต์, Docker Compose, health check | เสร็จ |
| Database schema และ index สำหรับ date overlap | เสร็จ |
| Authentication (JWT) และ input validation | เสร็จ |
| API 1: High-Concurrency Booking | เสร็จ |
| API 2: Dynamic Pricing Engine | เสร็จ |
| API 3: Booking Dashboard (WebSocket) | เสร็จ |
| Redis rate limiting | เสร็จ |
| Concurrency test | มีใน `test/bookings.test.ts` แล้ว ยังไม่มี load test แยก |
| Postman collection (`/postman`) | ยังไม่เริ่ม |

## แนวทางแก้ปัญหา

### Database schema (ทำแล้ว)

นิยามอยู่ใน `migrations/001_init.sql`

| ตาราง | เก็บอะไร |
|---|---|
| `users` | ผู้ใช้ อีเมล (unique) รหัสผ่านแบบ hash และ role (`user`, `admin`) |
| `room_types` | ประเภทห้องและราคาตั้งต้น หน่วยสตางค์ |
| `rooms` | ห้องแต่ละหลัง อ้างถึงประเภทห้อง |
| `bookings` | การจอง ช่วงวัน สถานะ ราคาที่คิด และกฎราคาที่ใช้ |

ตาราง `bookings` มี constraint สองตัวที่เกี่ยวกับช่วงวัน

```sql
CONSTRAINT bookings_valid_range CHECK (check_in < check_out),
CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
  room_id WITH =,
  daterange(check_in, check_out, '[)') WITH &&
) WHERE (status = 'confirmed')
```

- `bookings_no_overlap` ห้ามมีสองแถวที่ห้องเดียวกันและช่วงวันทับกัน ฐานข้อมูลบังคับกฎนี้เองในระดับ transaction จึงไม่ขึ้นกับลำดับการทำงานของโค้ดฝั่ง API
- ช่วงวันเป็นแบบ `[)` นับวัน check-in ไม่นับวัน check-out
- เงื่อนไข `WHERE (status = 'confirmed')` ทำให้การจองที่ยกเลิกแล้วไม่กันวัน
- Constraint นี้สร้าง GiST index บน `(room_id, daterange)` ซึ่งใช้ค้นหาช่วงวันที่ว่างด้วยตัวดำเนินการ `&&` ได้ ส่วน extension `btree_gist` ทำให้ GiST เทียบ `room_id` ด้วย `=` ได้
- เงินเก็บเป็น `BIGINT` หน่วยสตางค์

ข้อมูลตั้งต้นใน `migrations/002_seed.sql` คือประเภทห้อง "The Royal Hideaway" ราคา 20,000 บาท และห้อง 1 หลัง

### Authentication และ input validation (ทำแล้ว)

| Endpoint | หน้าที่ |
|---|---|
| `POST /auth/register` | สมัครสมาชิกด้วย `email` และ `password` (8–128 ตัวอักษร) ได้ role `user` เสมอ |
| `POST /auth/login` | เข้าสู่ระบบ คืน `accessToken` |
| `GET /auth/me` | ข้อมูลผู้ใช้ของ token ที่ส่งมา |

- Endpoint ที่ต้องยืนยันตัวตนรับ header `Authorization: Bearer <accessToken>` โดยใช้ preHandler `app.authenticate` หรือ `app.requireAdmin` (`src/auth/plugin.ts`)
- Token เป็น JWT แบบ HS256 อายุ 1 ชั่วโมง (`JWT_EXPIRES_IN` หน่วยวินาที) เก็บ `sub` (user id) และ `role` ฝั่งตรวจรับเฉพาะ HS256
- รหัสผ่าน hash ด้วย scrypt จาก `node:crypto` พร้อม salt แยกต่อผู้ใช้ และเทียบด้วย `timingSafeEqual` (`src/auth/password.ts`)
- Login ตอบ 401 ข้อความเดียวกันทั้งกรณีรหัสผ่านผิดและไม่มีอีเมล และรัน scrypt ทั้งสองกรณี เพื่อไม่ให้เดาได้ว่าอีเมลใดมีในระบบ
- ทุก endpoint ตรวจ body ด้วย zod แบบ strict ฟิลด์ที่ไม่รู้จัก (เช่น `role`) ถูกปฏิเสธด้วย 400 อีเมลถูกแปลงเป็นตัวพิมพ์เล็กก่อนบันทึก
- Error ทุกแบบตอบเป็น `{ "error": { "code", "message" } }` error ที่ไม่ได้คาดไว้ตอบ 500 โดยไม่เปิดเผยรายละเอียด (`src/errors.ts`)

ข้อจำกัด: role อยู่ใน token จึงมีผลจนกว่า token หมดอายุ ยังไม่มี refresh token และการเพิกถอน token

### API 1: High-Concurrency Booking (ทำแล้ว)

| Endpoint | สิทธิ์ | หน้าที่ |
|---|---|---|
| `GET /rooms` | ทุกคน | รายการห้อง ใส่ `?checkIn=&checkOut=` เพื่อดูว่าห้องว่างในช่วงนั้นหรือไม่ |
| `POST /bookings` | ผู้ใช้ | จองห้องด้วย `roomId`, `checkIn`, `checkOut` (รูปแบบ `YYYY-MM-DD`) |
| `GET /bookings` | ผู้ใช้ | การจองของตัวเอง |
| `GET /bookings/:id` | เจ้าของหรือ admin | การจองรายการเดียว |
| `POST /bookings/:id/cancel` | เจ้าของหรือ admin | ยกเลิกการจอง วันที่กลับมาว่างทันที |

`POST /bookings` กัน Overbooking สองชั้น (`src/bookings/routes.ts`)

1. **Redis distributed lock ต่อห้อง** (`src/redis/lock.ts`) ใช้ `SET NX PX` อายุ 5 วินาที พร้อม token สุ่ม และปลดล็อกด้วย Lua ที่ตรวจ token ก่อนลบ คำขอที่แย่งล็อกไม่ได้ถูกปฏิเสธทันทีด้วย 409 `ROOM_BUSY` และ header `Retry-After: 1` โดยไม่แตะฐานข้อมูลส่วนการจอง ชั้นนี้มีไว้ลดภาระฐานข้อมูล ไม่ได้รับประกันความถูกต้อง
2. **PostgreSQL exclusion constraint** `bookings_no_overlap` เป็นตัวรับประกันความถูกต้อง โค้ด `INSERT` ตรง ๆ โดยไม่ตรวจห้องว่างก่อน ถ้าช่วงวันทับกับการจองที่ยืนยันแล้ว ฐานข้อมูลตอบ error `23P01` ซึ่ง API แปลงเป็น 409 `ROOM_UNAVAILABLE` จึงไม่มีช่วงเวลาระหว่าง "ตรวจ" กับ "บันทึก" ให้คำขออื่นแทรก

กรณีที่ชั้นแรกใช้ไม่ได้

- Redis ล่ม: API ยังรับจองต่อโดยอาศัย constraint อย่างเดียว และ log คำเตือน
- ล็อกหมดอายุก่อนคำขอทำเสร็จ: คำขออื่นเข้ามาได้ แต่ constraint ยังกันการจองซ้อน

ข้อแลกเปลี่ยน: ล็อกเป็นระดับห้อง สองคำขอที่จองห้องเดียวกันคนละช่วงวันในเวลาเดียวกัน อาจมีคำขอหนึ่งได้ `ROOM_BUSY` ทั้งที่วันไม่ทับกัน ผู้เรียกต้องลองใหม่

สถานะที่ตอบ

| สถานะ | code | เมื่อใด |
|---|---|---|
| 201 | | จองสำเร็จ |
| 400 | `VALIDATION_ERROR` | วันที่ผิดรูปแบบ วันในอดีต `checkOut` ไม่อยู่หลัง `checkIn` หรือเกินขีดจำกัด |
| 401 | `UNAUTHORIZED` | ไม่มี token หรือ token ใช้ไม่ได้ |
| 404 | `ROOM_NOT_FOUND` | ไม่มีห้องนั้น |
| 409 | `ROOM_UNAVAILABLE` | ช่วงวันทับกับการจองที่ยืนยันแล้ว |
| 409 | `ROOM_BUSY` | มีคำขอจองห้องเดียวกันกำลังทำงานอยู่ ลองใหม่ได้ |

ราคาคำนวณด้วย Dynamic Pricing Engine (API 2) ภายใน transaction เดียวกับ `INSERT` และบันทึกไว้กับการจอง

เทสต์ใน `test/bookings.test.ts` ยิง 100 คำขอพร้อมกันในช่วงวันเดียวกันแล้วตรวจว่าสำเร็จ 1 รายการ ยิงคำขอที่ช่วงวันทับกันบางส่วนแล้วตรวจว่าไม่มีคู่ใดทับกันในฐานข้อมูล และยิง `INSERT` พร้อมกันโดยไม่ผ่านล็อกเพื่อยืนยันว่า constraint กันได้เอง

### API 2: Dynamic Pricing Engine (ทำแล้ว)

| Endpoint | สิทธิ์ | หน้าที่ |
|---|---|---|
| `GET /pricing/quote?roomId=&checkIn=&checkOut=` | ผู้ใช้ | ราคาที่จะได้ถ้าจองตอนนี้ พร้อมกฎที่ใช้ |

| กฎ | เงื่อนไข | ตัวคูณ |
|---|---|---|
| `LAST_ROOM` | ห้องประเภทเดียวกันที่ว่างตลอดช่วงวันที่ขอ เหลือ 1 ห้อง (นับห้องที่กำลังจอง) | ×1.20 |
| `PEAK_HOUR` | เวลาที่กดจองอยู่ระหว่าง 20:00 ถึงก่อน 22:00 ตามเวลา Asia/Bangkok | ×1.15 |
| `LOYAL_GUEST` | ผู้จองมีการจองที่ยืนยันแล้วและ check-out ไม่เกินวันนี้ ตั้งแต่ 4 ครั้งขึ้นไป | ×0.90 |

แบ่งเป็นสองชั้น

- **`src/pricing/engine.ts`** เป็น pure function `calculateNightlyPrice` รับราคาตั้งต้น เวลาที่จอง จำนวนห้องว่าง และจำนวนครั้งที่เคยพัก ไม่อ่านนาฬิกา ไม่แตะฐานข้อมูล จึงทดสอบทุกกรณีได้โดยตรง
- **`src/pricing/quote.ts`** ดึงข้อมูลที่ engine ต้องใช้จากฐานข้อมูล แล้วเรียก engine ใช้ทั้งใน `GET /pricing/quote` และ `POST /bookings`

การคำนวณเงิน

- ตัวคูณเก็บเป็น basis point (10000 = 1.0) คูณทุกตัวด้วย `BigInt` ก่อน แล้วหารและปัดครั้งเดียวตอนท้ายแบบปัดครึ่งขึ้น ไม่มีทศนิยมแบบ floating point แตะราคา ผลลัพธ์จึงไม่ขึ้นกับลำดับกฎ
- ราคารวม = ราคาต่อคืน × จำนวนคืน
- ทุกกฎที่เข้าเงื่อนไขถูกบันทึกใน `price_rules` ของการจอง พร้อมตัวคูณและคำอธิบาย

ความสอดคล้องเมื่อจองพร้อมกัน

- `POST /bookings` คำนวณราคาใน transaction เดียวกับ `INSERT` และล็อกแถวประเภทห้องด้วย `SELECT ... FOR NO KEY UPDATE` การจองห้องประเภทเดียวกันจึงคำนวณราคาทีละรายการ และจำนวนห้องว่างที่ใช้คิดกฎ `LAST_ROOM` ไม่ล้าสมัยก่อนบันทึก ข้อจำกัด: การยกเลิกไม่ได้ล็อกประเภทห้อง ถ้ามีการยกเลิกห้องอื่นในจังหวะเดียวกับการจอง ผู้จองอาจยังได้ +20% ทั้งที่มีห้องว่างเพิ่มขึ้นแล้ว
- ตัวอย่าง: ห้อง 2 หลังว่างอยู่ แล้วมีคำขอจองทั้งสองหลังพร้อมกัน ฝ่ายหนึ่งได้ราคาปกติ อีกฝ่ายได้ +20% เสมอ ไม่มีกรณีที่ทั้งคู่ได้ราคาปกติ
- ล็อกนี้ทำให้การจองห้องประเภทเดียวกันต่างห้องรอกันสั้น ๆ ระหว่างคำนวณ ซึ่งยอมรับได้เพราะ transaction มีเพียง 2 query และ 1 `INSERT`

ราคาจาก `GET /pricing/quote` ไม่ได้ถูกจองไว้ ราคาจริงคำนวณใหม่ตอน `POST /bookings` และอาจต่างได้ถ้าเวลาข้ามช่วง peak hour หรือมีคนจองห้องอื่นไปก่อน

เวลาปัจจุบันมาจาก `app.now()` ซึ่งเทสต์แทนค่าได้ เทสต์ใน `test/pricing.test.ts` ครอบคลุมขอบเวลา 19:59:59, 20:00:00, 21:59:59 และ 22:00:00 การรวมทุกคู่ของกฎ การปัดเศษ และการจองสองห้องสุดท้ายพร้อมกัน 10 รอบ

### API 3: Booking Dashboard (ทำแล้ว)

| Endpoint | สิทธิ์ | หน้าที่ |
|---|---|---|
| `GET /admin/dashboard` | admin | snapshot ของ dashboard ผ่าน HTTP |
| `GET /admin/dashboard/ws` (WebSocket) | admin | snapshot ตอนเชื่อมต่อ แล้วส่ง event การจองแบบ real-time |

**การยืนยันตัวตนของ WebSocket** มีสองทาง

1. ส่ง header `Authorization: Bearer <token>` ตอนเชื่อมต่อ (Postman, ฝั่ง server) ถ้า token ไม่ใช่ admin จะถูกปฏิเสธก่อน upgrade ด้วย HTTP 401 หรือ 403
2. เชื่อมต่อโดยไม่มี header แล้วส่งข้อความแรกเป็น `{"type":"auth","token":"<token>"}` ภายใน 5 วินาที สำหรับ browser ซึ่งตั้ง header ของ WebSocket ไม่ได้

ไม่รับ token ใน URL เพราะจะไปอยู่ใน access log ถ้ายืนยันตัวตนไม่ผ่าน socket ถูกปิดด้วย code `4401` (token ใช้ไม่ได้ หมดเวลา หรือข้อความแรกไม่ใช่ `auth`) หรือ `4403` (ไม่ใช่ admin) และเมื่อ token หมดอายุ socket ที่เปิดด้วย token นั้นถูกปิดด้วย `4401`

**ข้อความจาก server**

| `type` | เนื้อหา | เมื่อใด |
|---|---|---|
| `snapshot` | `data`: `summary` (จำนวนห้อง ห้องที่มีคนพักคืนนี้ check-in/check-out วันนี้ การจองที่ยังไม่ check-out การจองที่ยกเลิก รายได้รวมของการจองที่ยืนยันแล้ว) และ `recentBookings` 20 รายการล่าสุด | หลังยืนยันตัวตน และเมื่อ client ส่ง `{"type":"snapshot"}` |
| `booking.created` | `booking`, `occurredAt` | หลัง transaction ของการจอง commit แล้ว |
| `booking.cancelled` | `booking`, `occurredAt` | เมื่อการจองเปลี่ยนจาก confirmed เป็น cancelled การยกเลิกซ้ำไม่ส่ง event |
| `error` | `error.code` | client ส่งข้อความที่ไม่รู้จัก |

**การกระจาย event** (`src/dashboard/`)

- `POST /bookings` และการยกเลิก `PUBLISH` event ไปที่ Redis channel `dashboard:booking-events` หลัง commit แบบไม่รอผล ถ้า Redis ล่ม การจองยังสำเร็จ dashboard แค่พลาด event นั้นและเห็นใน snapshot ครั้งถัดไป
- API ทุก instance `SUBSCRIBE` channel นี้ด้วย Redis connection แยก แล้วส่งต่อให้ socket ที่เชื่อมกับ instance ตัวเอง จึงขยายเป็นหลาย instance ได้
- Event ที่มาถึงระหว่างโหลด snapshot ถูกพักไว้แล้วส่งตามหลัง snapshot จึงไม่หาย แต่ event นั้นอาจซ้ำกับข้อมูลใน snapshot client ควรใช้ `booking.id` และ `status` ล่าสุดเป็นหลัก
- Server ส่ง ping ทุก 30 วินาที และตัด client ที่ไม่ตอบ client ที่รับข้อความไม่ทันจน buffer เกิน 1 MB ก็ถูกตัด ข้อความจาก client จำกัดขนาด 8 KB

ข้อจำกัด: Redis Pub/Sub ไม่เก็บ event ย้อนหลัง client ที่หลุดแล้วเชื่อมใหม่ต้องใช้ snapshot ที่ได้ตอนเชื่อมต่อแทน event ที่พลาดไป

เทสต์ใน `test/dashboard.test.ts` ครอบคลุมการยืนยันตัวตนทั้งสองทาง การปิด socket เมื่อ token หมดอายุ การยิงจอง 50 คำขอพร้อมกันแล้วได้ event เดียว และการส่ง event จาก API instance อื่นผ่าน Redis

### Redis rate limiting (ทำแล้ว)

| กฎ | ใช้กับ | นับตาม | ขีดจำกัดต่อ 1 นาที |
|---|---|---|---|
| `global` | ทุก request ยกเว้น `GET /health` | IP | 300 |
| `auth` | `POST /auth/register`, `POST /auth/login` | IP | 20 |
| `loginEmail` | `POST /auth/login` | email ที่พยายาม login | 10 |
| `booking` | `POST /bookings` | ผู้ใช้ (จาก token ที่ตรวจแล้ว) | 30 |
| `dashboardWs` | การเชื่อมต่อ WebSocket ของ dashboard | IP | 30 |

- **ตัวนับ** (`src/rate-limit/limiter.ts`) เป็น fixed window ใน Redis ใช้ Lua script เดียวทำ `INCR` และตั้งอายุ key จึง atomic คำขอพร้อมกัน 100 รายการที่ขีดจำกัด 10 ผ่าน 10 รายการพอดี
- **เมื่อเกิน** ตอบ 429 code `RATE_LIMITED` พร้อม header `Retry-After` ทุก response ที่ผ่านตัวนับมี `X-RateLimit-Limit`, `X-RateLimit-Remaining` และ `X-RateLimit-Reset` (วินาที) ถ้า request เข้าหลายกฎ header รายงานกฎที่เหลือน้อยที่สุด
- **ลำดับ** กฎ `global` ทำงานใน `onRequest` ก่อนอย่างอื่น ส่วนกฎ `booking` ทำงานหลังตรวจ token จึงนับตาม user id ที่ปลอมไม่ได้ และทั้งหมดทำงานก่อน Redis lock กับฐานข้อมูล
- **กฎ `loginEmail`** นับตาม email (hash ก่อนใช้เป็น key) จึงจำกัดการเดารหัสผ่านของบัญชีเดียวจากหลาย IP ได้
- **Redis ล่ม** ปล่อย request ผ่านโดยไม่จำกัด (fail open) และ log คำเตือน โดยตรวจสถานะ connection ก่อน จึงไม่ทำให้แต่ละ request ช้าลง
- **IP ของ client** มาจาก socket โดยตรง header `X-Forwarded-For` ถูกเชื่อเฉพาะเมื่อตั้ง `TRUST_PROXY=true` ซึ่งควรตั้งเมื่ออยู่หลัง reverse proxy เท่านั้น ไม่อย่างนั้น client ปลอม header เพื่อหลบขีดจำกัดได้
- **ปิดได้** ด้วย `RATE_LIMIT_ENABLED=false` สำหรับ load test ที่ยิงจากเครื่องเดียว

ข้อจำกัด

- Fixed window ยอมให้เกิด burst ได้สูงสุด 2 เท่าของขีดจำกัดตรงรอยต่อของสอง window
- เมื่อรันด้วย Docker บนเครื่องเดียว ทุก request มาจาก IP ของ Docker gateway จึงใช้ตัวนับต่อ IP ร่วมกัน
- กฎ `loginEmail` ทำให้ผู้อื่นกันเจ้าของบัญชี login ได้ชั่วคราว 1 นาทีต่อรอบ โดยยิง login ผิดซ้ำ ๆ เป็นข้อแลกเปลี่ยนกับการกันเดารหัสผ่าน

เทสต์ใน `test/rate-limit.test.ts` ครอบคลุมทุกกฎ การแยกตัวนับตาม IP และผู้ใช้ การหมดอายุของ window การปลอม `X-Forwarded-For` และกรณี Redis ต่อไม่ได้ เทสต์ไฟล์อื่นปิด rate limit เพราะยิงจาก address เดียวกันหลายร้อยครั้งโดยตั้งใจ

## สมมติฐาน

| ประเด็นที่โจทย์ไม่ระบุ | การตัดสินใจ | เหตุผล |
|---|---|---|
| วิธีรวมหลายกฎราคา | คูณทบกัน เช่น 20,000 × 1.2 × 1.15 × 0.9 = 24,840 บาท | แต่ละกฎเป็นการปรับจากราคาปัจจุบัน และผลลัพธ์ไม่ขึ้นกับลำดับ |
| "ห้องสุดท้าย" เมื่อมีห้องเพียง 1 หลัง | Schema รองรับหลายห้องต่อประเภท กฎทำงานเมื่อช่วงวันที่ขอเหลือห้องว่าง 1 ห้อง | ใช้กฎเดิมได้เมื่อเพิ่มจำนวนห้อง กรณี 1 หลังจึงได้ +20% เสมอ |
| Peak Hour วัดจากเวลาใด | เวลาที่กดจอง ตามเขตเวลา Asia/Bangkok ตั้งแต่ 20:00 ถึงก่อน 22:00 | โจทย์ระบุว่าคำนวณแบบ real-time และรีสอร์ทอยู่ในไทย |
| "เคยพักมากกว่า 3 ครั้ง" | การจองที่ check-out ผ่านไปแล้วตั้งแต่ 4 ครั้งขึ้นไป | "มากกว่า 3" ไม่รวม 3 และการจองที่ยังไม่ได้เข้าพักไม่นับเป็นการพัก |
| หน่วยของ Base Price | 20,000 บาทต่อคืน | เป็นหน่วยราคาห้องพักทั่วไป |
| ขีดจำกัดการจอง | พักได้ไม่เกิน 30 คืน จองล่วงหน้าได้ไม่เกิน 365 วัน และ check-in ต้องไม่ใช่วันในอดีตตามเขตเวลา Asia/Bangkok | กันการจองที่ผิดปกติและจำกัดขนาดข้อมูล |
| การยกเลิก | เจ้าของหรือ admin ยกเลิกได้ทุกเมื่อ ไม่มีค่าปรับ | โจทย์ไม่ระบุนโยบายยกเลิก |
| ช่วงวันที่จอง | `[check_in, check_out)` วัน check-out ของคนหนึ่งเป็นวัน check-in ของอีกคนได้ | ตรงกับการใช้งานจริงของโรงแรม |
| Dashboard แสดงอะไร | snapshot สรุปจำนวนและรายได้ พร้อมการจองล่าสุด แล้วส่ง event เมื่อมีการจองหรือยกเลิก | โจทย์ระบุเพียง dashboard แบบ real-time ข้อมูลเหล่านี้คือสิ่งที่ผู้ดูแลรีสอร์ทต้องเห็นทันที |

## การใช้ AI

ใช้ Claude Code (Claude Fable 5.2 และ Claude Opus 5.5 ตั้งแต่ส่วน API 2) ช่วยวางแผนและเขียนโค้ด โดยทำทีละส่วน

### ส่วนที่ใช้ AI

| ส่วน | สิ่งที่ AI ทำ | สิ่งที่ทำเอง |
|---|---|---|
| วางแผน | เสนอ stack แนวทางกัน Overbooking และรายการสมมติฐาน | เลือก stack และวิธีรวมกฎราคา |
| โครงโปรเจกต์ | เขียนไฟล์ใน `src/`, `Dockerfile`, `docker-compose.yml`, ไฟล์ตั้งค่า และเทสต์ health check ลง repo โดยตรง | ตรวจไฟล์และ commit |
| Database schema และ migration | ออกแบบ schema และให้เนื้อหา `migrations/*.sql`, `src/db/migrate.ts` พร้อมคำอธิบาย | พิมพ์โค้ดเองทีละไฟล์ แก้ `src/server.ts` และ `Dockerfile` รัน container ตรวจ log และ commit |
| Authentication | เขียน `src/auth/*`, `src/errors.ts`, เทสต์ใน `test/auth.test.ts` และแก้ config ลง repo โดยตรง เลือก scrypt และวิธีสร้าง admin จาก env | ตรวจโค้ดและ commit |
| API 1: Booking | เขียน `src/bookings/*`, `src/redis/lock.ts` และ `test/bookings.test.ts` ลง repo โดยตรง กำหนดขีดจำกัดการจองและให้ API ทำงานต่อเมื่อ Redis ล่ม | ตรวจโค้ดและ commit |
| API 2: Pricing | เขียน `src/pricing/*`, `src/bookings/schemas.ts`, `src/db/transaction.ts`, `test/pricing.test.ts` และปรับ `POST /bookings` ลง repo โดยตรง เลือกวิธีปัดเศษ การล็อกประเภทห้อง และนิยาม "การพักที่เสร็จแล้ว" | ตรวจโค้ดและ commit |
| API 3: Dashboard | เขียน `src/dashboard/*`, `src/bookings/model.ts`, `test/dashboard.test.ts` และปรับ `POST /bookings` กับการยกเลิกให้ส่ง event ลง repo โดยตรง เลือกวิธียืนยันตัวตนของ WebSocket และเนื้อหา snapshot | ตรวจโค้ดและ commit แก้การ subscribe และเทสต์ token หมดอายุด้วยตัวเองตามผลตรวจ |
| Rate limiting | เขียน `src/rate-limit/*`, `test/rate-limit.test.ts` และต่อเข้ากับ route ลง repo โดยตรง เลือกแบบ fixed window ค่าขีดจำกัด และให้ปล่อยผ่านเมื่อ Redis ล่ม | ตรวจโค้ดและ commit |
| README | ร่างและอัปเดตเอกสารฉบับนี้ | ตรวจและแก้เนื้อหา |

### สิ่งที่ AI ทำผิดและวิธีแก้

**1. รหัสผ่านฐานข้อมูลใน `docker-compose.yml` กับ `.env.example` ไม่ตรงกัน**

- สิ่งที่ AI ทำ: ตั้งค่า default ของ `POSTGRES_PASSWORD` ใน `docker-compose.yml` เป็นค่าหนึ่ง แต่ใส่อีกค่าหนึ่งใน `.env.example` และไม่ได้ระบุว่า PostgreSQL ตั้งรหัสผ่านเฉพาะตอนสร้าง volume ครั้งแรก
- ผลที่เกิด: รัน stack ครั้งแรกโดยไม่มี `.env` แล้วสร้าง `.env` จาก `.env.example` ภายหลัง เมื่อ build ใหม่ API ส่งรหัสผ่านใหม่ไปยังฐานข้อมูลที่ยังใช้รหัสเดิม จึงเริ่มทำงานไม่ได้ด้วย error `28P01` (password authentication failed)
- วิธีที่พบ: อ่าน log ของ container `api` แล้วเทียบเวลาที่สร้าง `.env` กับเวลาที่สร้าง volume
- วิธีแก้: ลบ volume ด้วย `docker-compose down -v` แล้วรันใหม่ และเพิ่มขั้นตอนนี้ไว้ในหัวข้อวิธีติดตั้งและรัน
