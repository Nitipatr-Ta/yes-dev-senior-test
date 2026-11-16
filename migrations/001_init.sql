CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_types (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  base_price_satang BIGINT NOT NULL CHECK (base_price_satang > 0)
);

CREATE TABLE rooms (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_type_id BIGINT NOT NULL REFERENCES room_types (id),
  name         TEXT NOT NULL UNIQUE
);

CREATE TABLE bookings (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id              BIGINT NOT NULL REFERENCES rooms (id),
  user_id              BIGINT NOT NULL REFERENCES users (id),
  check_in             DATE NOT NULL,
  check_out            DATE NOT NULL,
  status               TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  nightly_price_satang BIGINT NOT NULL CHECK (nightly_price_satang > 0),
  total_price_satang   BIGINT NOT NULL CHECK (total_price_satang > 0),
  price_rules          JSONB NOT NULL DEFAULT '[]',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bookings_valid_range CHECK (check_in < check_out),
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE INDEX bookings_user_id_idx ON bookings (user_id);