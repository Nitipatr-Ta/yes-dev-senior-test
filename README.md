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

ค่าเริ่มต้นใน `docker-compose.yml` ใช้สำหรับ local development เท่านั้น หากต้องการเปลี่ยนพอร์ตหรือรหัสผ่านฐานข้อมูล ให้คัดลอก `.env.example` เป็น `.env` แล้วแก้ค่า

### รันเทสต์

เทสต์ต่อกับ PostgreSQL และ Redis จริง จึงต้องเปิด container ไว้ก่อน

```bash
npm install
DATABASE_URL=postgres://booking:booking_local_dev@localhost:5432/booking REDIS_URL=redis://localhost:6379 npm test
```

## สถานะงาน

| ส่วน | สถานะ |
|---|---|
| โครงโปรเจกต์, Docker Compose, health check | เสร็จ |
| Database schema และ index สำหรับ date overlap | ยังไม่เริ่ม |
| Authentication (JWT) และ input validation | ยังไม่เริ่ม |
| API 1: High-Concurrency Booking | ยังไม่เริ่ม |
| API 2: Dynamic Pricing Engine | ยังไม่เริ่ม |
| API 3: Booking Dashboard (WebSocket) | ยังไม่เริ่ม |
| Redis rate limiting | ยังไม่เริ่ม |
| Concurrency test | ยังไม่เริ่ม |
| Postman collection (`/postman`) | ยังไม่เริ่ม |

## แนวทางแก้ปัญหา

> ส่วนนี้คือการออกแบบที่วางไว้ จะปรับให้ตรงกับโค้ดจริงเมื่อแต่ละส่วนเสร็จ

### กัน Overbooking

ใช้สองชั้น

1. **Redis distributed lock ต่อห้อง** (`SET NX PX` พร้อม token และปลดล็อกด้วย Lua ที่ตรวจ token) คำขอที่แย่งล็อกไม่ได้จะถูกปฏิเสธทันที ลดภาระที่ฐานข้อมูลเมื่อมีคำขอเข้ามาพร้อมกันจำนวนมาก
2. **PostgreSQL exclusion constraint** บนช่วงวัน `daterange(check_in, check_out, '[)')` ด้วย GiST index ฐานข้อมูลจะปฏิเสธแถวที่ช่วงวันซ้อนกับการจองที่ยังมีผลในห้องเดียวกัน ชั้นนี้เป็นตัวรับประกันความถูกต้อง แม้ Redis lock หมดอายุกลางทางหรือ Redis ล่ม

GiST index เดียวกันใช้ค้นหาช่วงวันที่ว่างด้วย

### Dynamic Pricing

เป็น pure function ที่รับเวลา จำนวนห้องว่าง และประวัติการพักของลูกค้า คำนวณด้วยจำนวนเต็มหน่วยสตางค์ ราคาและกฎที่ใช้จะถูกบันทึกไว้กับการจอง

### Dashboard

WebSocket สำหรับ admin โดยกระจาย event การจองผ่าน Redis Pub/Sub

### Rate limiting และ Security

Rate limit ด้วย Redis แยกตาม IP และผู้ใช้ ยืนยันตัวตนด้วย JWT และตรวจ input ทุก endpoint ด้วย zod

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

ใช้ Claude Code (Claude Fable 5.2) ช่วยวางแผนและเขียนโค้ด โดยทำทีละส่วนและตรวจ diff ก่อน commit

### ส่วนที่ใช้ AI

| ส่วน | สิ่งที่ AI ทำ |
|---|---|
| วางแผน | เสนอ stack แนวทางกัน Overbooking และรายการสมมติฐาน |
| โครงโปรเจกต์ | เขียน `src/`, `Dockerfile`, `docker-compose.yml`, ไฟล์ตั้งค่า และเทสต์ health check |
| README | ร่างเอกสารฉบับนี้ |

### สิ่งที่ตรวจทานและแก้ไข

ยังไม่มีรายการ
