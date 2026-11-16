INSERT INTO room_types (name, base_price_satang)
VALUES ('The Royal Hideaway', 2000000);

INSERT INTO rooms (room_type_id, name)
SELECT id, 'Royal Hideaway Villa 1'
FROM room_types
WHERE name = 'The Royal Hideaway';