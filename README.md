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

ค่าเริ่มต้นใน `docker-compose.yml` ใช้สำหรับ local development เท่านั้น หากต้องการเปลี่ยนพอร์ต รหัสผ่านฐานข้อมูล `JWT_SECRET` หรือบัญชี admin ให้คัดลอก `.env.example` เป็น `.env` แล้วแก้ค่า

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
| API 1: High-Concurrency Booking | ยังไม่เริ่ม |
| API 2: Dynamic Pricing Engine | ยังไม่เริ่ม |
| API 3: Booking Dashboard (WebSocket) | ยังไม่เริ่ม |
| Redis rate limiting | ยังไม่เริ่ม |
| Concurrency test | ยังไม่เริ่ม |
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

> หัวข้อถัดจากนี้คือการออกแบบที่วางไว้ ยังไม่มีโค้ด จะปรับให้ตรงกับโค้ดจริงเมื่อแต่ละส่วนเสร็จ

### กัน Overbooking

ใช้สองชั้น

1. **Redis distributed lock ต่อห้อง** (`SET NX PX` พร้อม token และปลดล็อกด้วย Lua ที่ตรวจ token) คำขอที่แย่งล็อกไม่ได้จะถูกปฏิเสธทันที ลดภาระที่ฐานข้อมูลเมื่อมีคำขอเข้ามาพร้อมกันจำนวนมาก
2. **PostgreSQL exclusion constraint** `bookings_no_overlap` ข้างต้น ชั้นนี้เป็นตัวรับประกันความถูกต้อง แม้ Redis lock หมดอายุกลางทางหรือ Redis ล่ม

### Dynamic Pricing

เป็น pure function ที่รับเวลา จำนวนห้องว่าง และประวัติการพักของลูกค้า คำนวณด้วยจำนวนเต็มหน่วยสตางค์ ราคาและกฎที่ใช้จะถูกบันทึกไว้กับการจอง

### Dashboard

WebSocket สำหรับ admin โดยกระจาย event การจองผ่าน Redis Pub/Sub

### Rate limiting และ Security

Rate limit ด้วย Redis แยกตาม IP และผู้ใช้ รวมถึง `POST /auth/login` เพื่อกันการเดารหัสผ่าน

## สมมติฐาน

| ประเด็นที่โจทย์ไม่ระบุ | การตัดสินใจ | เหตุผล |
|---|---|---|
| วิธีรวมหลายกฎราคา | คูณทบกัน เช่น 20,000 × 1.2 × 1.15 × 0.9 = 24,840 บาท | แต่ละกฎเป็นการปรับจากราคาปัจจุบัน และผลลัพธ์ไม่ขึ้นกับลำดับ |
| "ห้องสุดท้าย" เมื่อมีห้องเพียง 1 หลัง | Schema รองรับหลายห้องต่อประเภท กฎทำงานเมื่อช่วงวันที่ขอเหลือห้องว่าง 1 ห้อง | ใช้กฎเดิมได้เมื่อเพิ่มจำนวนห้อง กรณี 1 หลังจึงได้ +20% เสมอ |
| Peak Hour วัดจากเวลาใด | เวลาที่กดจอง ตามเขตเวลา Asia/Bangkok ตั้งแต่ 20:00 ถึงก่อน 22:00 | โจทย์ระบุว่าคำนวณแบบ real-time และรีสอร์ทอยู่ในไทย |
| "เคยพักมากกว่า 3 ครั้ง" | การจองที่ check-out ผ่านไปแล้วตั้งแต่ 4 ครั้งขึ้นไป | "มากกว่า 3" ไม่รวม 3 และการจองที่ยังไม่ได้เข้าพักไม่นับเป็นการพัก |
| หน่วยของ Base Price | 20,000 บาทต่อคืน | เป็นหน่วยราคาห้องพักทั่วไป |
| ช่วงวันที่จอง | `[check_in, check_out)` วัน check-out ของคนหนึ่งเป็นวัน check-in ของอีกคนได้ | ตรงกับการใช้งานจริงของโรงแรม |

## การใช้ AI

ใช้ Claude Code (Claude Fable 5.2) ช่วยวางแผนและเขียนโค้ด โดยทำทีละส่วน

### ส่วนที่ใช้ AI

| ส่วน | สิ่งที่ AI ทำ | สิ่งที่ทำเอง |
|---|---|---|
| วางแผน | เสนอ stack แนวทางกัน Overbooking และรายการสมมติฐาน | เลือก stack และวิธีรวมกฎราคา |
| โครงโปรเจกต์ | เขียนไฟล์ใน `src/`, `Dockerfile`, `docker-compose.yml`, ไฟล์ตั้งค่า และเทสต์ health check ลง repo โดยตรง | ตรวจไฟล์และ commit |
| Database schema และ migration | ออกแบบ schema และให้เนื้อหา `migrations/*.sql`, `src/db/migrate.ts` พร้อมคำอธิบาย | พิมพ์โค้ดเองทีละไฟล์ แก้ `src/server.ts` และ `Dockerfile` รัน container ตรวจ log และ commit |
| Authentication | เขียน `src/auth/*`, `src/errors.ts`, เทสต์ใน `test/auth.test.ts` และแก้ config ลง repo โดยตรง เลือก scrypt และวิธีสร้าง admin จาก env | ตรวจโค้ดและ commit |
| README | ร่างและอัปเดตเอกสารฉบับนี้ | ตรวจและแก้เนื้อหา |

### สิ่งที่ AI ทำผิดและวิธีแก้

**1. รหัสผ่านฐานข้อมูลใน `docker-compose.yml` กับ `.env.example` ไม่ตรงกัน**

- สิ่งที่ AI ทำ: ตั้งค่า default ของ `POSTGRES_PASSWORD` ใน `docker-compose.yml` เป็นค่าหนึ่ง แต่ใส่อีกค่าหนึ่งใน `.env.example` และไม่ได้ระบุว่า PostgreSQL ตั้งรหัสผ่านเฉพาะตอนสร้าง volume ครั้งแรก
- ผลที่เกิด: รัน stack ครั้งแรกโดยไม่มี `.env` แล้วสร้าง `.env` จาก `.env.example` ภายหลัง เมื่อ build ใหม่ API ส่งรหัสผ่านใหม่ไปยังฐานข้อมูลที่ยังใช้รหัสเดิม จึงเริ่มทำงานไม่ได้ด้วย error `28P01` (password authentication failed)
- วิธีที่พบ: อ่าน log ของ container `api` แล้วเทียบเวลาที่สร้าง `.env` กับเวลาที่สร้าง volume
- วิธีแก้: ลบ volume ด้วย `docker-compose down -v` แล้วรันใหม่ และเพิ่มขั้นตอนนี้ไว้ในหัวข้อวิธีติดตั้งและรัน
