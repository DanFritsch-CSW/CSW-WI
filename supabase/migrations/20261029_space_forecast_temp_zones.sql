-- Space Forecast: give every facility its temperature zones (2026-10-29).
-- Insert-only and idempotent: skips a zone whose (facility, name) already exists,
-- never edits or deletes a zone or customer. New zones start at capacity 0 so no
-- false utilization shows; capacity is filled in from the UI / racking walks.
--   Caledonia: Freezer, Cooler   (existing "Facility" zone untouched)
--   Eau Claire: Freezer, Cooler, Dry (existing "Facility" zone untouched)
--   Wisconsin Rapids: Cooler     (Freezer already exists)
-- Dry exists only at Madison and Eau Claire.
insert into space_forecast_zones (facility, name, note, capacity, sort_order)
select v.facility, v.name, '', 0, v.so
from (values
  ('cal', 'Freezer', 1), ('cal', 'Cooler', 2),
  ('ec',  'Freezer', 1), ('ec',  'Cooler', 2), ('ec', 'Dry', 3),
  ('wr',  'Cooler',  1)
) as v(facility, name, so)
where not exists (select 1 from space_forecast_zones z where z.facility = v.facility and z.name = v.name);
