-- Initial project mapping for Space Forecast (2026-10-29).
-- Links existing plan rows (by id) to their Datex warehouse + project.
-- Insert-only and idempotent: it never edits or deletes a plan row, skips any
-- customer id that no longer exists, and skips mappings that already exist.
--
-- Warehouse ids: 1 Franksville (Caledonia), 3 Eau Claire, 4 Madison,
--                5 Kenosha, 6 Wisconsin Rapids.
-- Material group ids: 7 Cooler, 11 Dry, 14 Freezer (only used where one Datex
-- project is split across plan rows: DPI + Colony at Madison, Good Foods at Kenosha).
--
-- Deliberately NOT mapped (left for Dan / Wasz to decide, they show in "Unmapped"):
--   Madison  Givaudan 2027 Annatto Seeds, Darigold frozen, Kraft butter
--   Caledonia miscellaneous, Novonesis (cooler)
--   Kenosha  Givaudan, Miscellaneous
--   Eau Claire Miscellaneous

insert into space_forecast_project_map (facility, warehouse_id, project_id, material_group_id, project_name, customer_id)
select v.facility, v.wid, v.pid, v.mg, v.pname, v.cid::uuid
from (values
  -- Caledonia
  ('cal', 1, 351, null::int, 'Calumet Diversified Meats - Caledonia',   '3354d98e-f147-4475-900b-b812354feba2'),
  ('cal', 1, 353, null,      'Campbell''s - Caledonia',                 'a2822c15-5695-4b04-ba98-39a9f0a52e65'),
  ('cal', 1,  13, null,      'O&H -Caledonia',                          'bcc41fd8-b1d0-469c-8b5e-0e9e018829fa'),
  ('cal', 1, 153, null,      'O&H DANISH BAKERY, INC',                  'bcc41fd8-b1d0-469c-8b5e-0e9e018829fa'),
  ('cal', 1,   8, null,      'Palermos CALEDONIA materials bulk',       'a7d666fe-9691-4cdd-9437-be5e95dceace'),
  ('cal', 1, 311, null,      'PERFORMANCE FOOD SERVICE',                '4fb8ea40-c67f-4730-8c7a-9b939080101d'),
  ('cal', 1,   5, null,      'Palermos CALEDONIA finished',             '79edfc7b-f3cf-4a9c-b57a-969f3679cc03'),
  ('cal', 1, 250, null,      'Palermo''s Caledonia DSD',                '79edfc7b-f3cf-4a9c-b57a-969f3679cc03'),
  ('cal', 1, 234, null,      'Sargento Cheese Inc-Caledonia',           'fdc2a254-5e30-4095-9058-2f2331401daa'),
  -- Eau Claire
  ('ec', 3, 253, null, 'DPI - CSW-Eau Claire',                          '5094b6d2-fe85-4f29-9bcf-f872ab46bfc2'),
  ('ec', 3, 265, null, 'DSM-Firmenich Canada Inc - Eau Claire',         'c71f6f3d-0279-48b4-9b31-594bc6dab2b4'),
  ('ec', 3, 258, null, 'Lakeside Foods, Inc. - Bulk Eau Claire',        '5a03c05a-7a62-4667-bfd2-fca1ab1eee4b'),
  ('ec', 3, 266, null, 'Northstar Bison LLC - Eau Claire',              '043d6689-be25-4c81-b7b9-835f20bfa07e'),
  ('ec', 3, 263, null, 'Rise Baking Co. - Best Maid Cookie - Eau Claire','76fda7a9-ed00-47da-8b8a-1b3a7560d38a'),
  -- Kenosha
  ('ken', 5,  67, null, 'DSM FOOD SPECIALTIES, USA',                    'aaebf3b4-c6c6-4254-bd75-4e0ef58330b2'),
  ('ken', 5,  66, null, 'DSM FOOD SPECIALTIES USA, INC. (EN)',          'aaebf3b4-c6c6-4254-bd75-4e0ef58330b2'),
  ('ken', 5,  64, null, 'DSM PACKAGING',                                'aaebf3b4-c6c6-4254-bd75-4e0ef58330b2'),
  ('ken', 5, 371, null, 'DSM Nutritional Products, LLC',                'aaebf3b4-c6c6-4254-bd75-4e0ef58330b2'),
  ('ken', 5,  56,    7, 'GOOD FOODS GROUP',                             '014a5bb7-9429-4478-b4cd-25a3c941e4c0'),
  ('ken', 5,  56,   14, 'GOOD FOODS GROUP',                             'a664efed-0592-4b66-8ffc-f069163f864f'),
  ('ken', 5, 143, null, 'ABBVIE',                                       'afc73e95-12ad-4ccf-9d15-111a49dd7fbb'),
  ('ken', 5, 242, null, 'BIRCHWOOD FOODS  KENOSHA',                     '3dbf4646-71f5-4a78-bdec-c1cde349a024'),
  ('ken', 5, 370, null, 'BossBites',                                    '2adfa61a-14a3-4cb7-8efd-6126586a1804'),
  ('ken', 5,  63, null, 'CALUMET DIVERSIFIED MEATS',                    '7deb2d92-3478-4af2-9f4c-dcaaa8d1d092'),
  ('ken', 5,  35, null, 'CROWN BAKERIES',                               '95c2f590-f0ff-4a1c-9a0a-21b5a55e0582'),
  ('ken', 5, 128, null, 'Echo Lakes Foods Inc- KENOSHA',                '1e7dd946-79fa-4510-b2cb-2da2fd4ed360'),
  ('ken', 5,  60, null, 'FAIR OAKS FARMS',                              '353d0761-028e-4535-b273-6e5a35aae5c1'),
  ('ken', 5,  61, null, 'FAIR OAKS FARMS WEST',                         '353d0761-028e-4535-b273-6e5a35aae5c1'),
  ('ken', 5, 116, null, 'MEIJER- Kenosha',                              '1329d73a-17bb-456c-9f87-0e77853bdc73'),
  ('ken', 5, 153, null, 'O&H DANISH BAKERY, INC',                       'b91c21f4-05f0-4d45-b475-9f0e659aa969'),
  ('ken', 5,  55, null, 'OCEAN SPRAY/KENOSHA',                          '553eb9dc-585f-481b-8c0a-7a9b832141eb'),
  ('ken', 5, 357, null, 'Pedone Pinsa',                                 'e42b7047-0a48-4410-a43e-f9fb8ad73ddc'),
  ('ken', 5,  53, null, 'POPCORN FACTORY  Kenosha',                     '045ffa8f-6ebf-4706-90b0-97b48c79f7db'),
  ('ken', 5, 230, null, 'Pretzilla Kenosha',                            'd82a3dd9-8035-44e9-bbf3-44b4d836d1c2'),
  ('ken', 5, 219, null, 'RICHELIEU KENOSHA',                            'e0697183-5826-468e-bd45-35caa6144735'),
  ('ken', 5, 224, null, 'RICHELIEU RAW MATERIALS KENOSHA',              'e0697183-5826-468e-bd45-35caa6144735'),
  ('ken', 5, 372, null, 'Roncadin - Finished Goods',                    'c7c04075-171b-47a1-8d7f-2e2b387a66ec'),
  ('ken', 5, 374, null, 'Roncadin - Raw Materials',                     'c7c04075-171b-47a1-8d7f-2e2b387a66ec'),
  ('ken', 5, 345, null, 'Thomas Foods - Kenosha',                       'aaa623b3-7419-4625-aad8-3ff267eee5c0'),
  ('ken', 5, 368, null, 'Viva Raw',                                     '285652a3-fd02-4cfe-9c6d-f82b389fe075'),
  -- Madison
  ('mad', 4,  78,   14, 'Colony Brands - CSW-Madison',                  'c98016c0-36cb-4ab8-b63c-0a3e38cda491'),
  ('mad', 4,  78,   11, 'Colony Brands - CSW-Madison',                  'db69de46-933e-4004-b12e-8e5ff5674bee'),
  ('mad', 4, 208, null, 'DDR Meat Solutions - CSW-Madison',             '43a6065c-f8ae-48bb-979e-4ede8c9cb715'),
  ('mad', 4, 122,   14, 'DPI - CSW-Madison',                            '2847faba-4793-43f5-b5e0-abec7809d87a'),
  ('mad', 4, 122,    7, 'DPI - CSW-Madison',                            '24b651d7-0d3f-4885-a1cc-2e4d36588985'),
  ('mad', 4, 122,   11, 'DPI - CSW-Madison',                            '89d5ef7d-645f-4155-908e-5a14b871b4b5'),
  ('mad', 4,  65, null, 'Grassland WM - Frozen - CSW-Madison',          '18f8da02-a9b8-46b6-8e01-aa747e3660bf'),
  ('mad', 4, 181, null, 'Grassland WM - Cooler - CSW-Madison',          'ce558d62-73d4-4247-b768-942abc23da1a'),
  ('mad', 4, 301, null, 'Grassland Sam''s - Cooler - CSW-Madison',      '3963bbd8-415a-4e18-bb7f-5d4bd734c560'),
  ('mad', 4, 162, null, 'Ocean Spray - CSW-Madison',                    '4d691907-7d5d-4100-95d9-16c725b536fc'),
  ('mad', 4, 185, null, 'Bayer - CSW-Madison',                          '3d565e30-3930-45d7-b68b-aca8906347a5'),
  ('mad', 4, 106, null, 'Lakeside Bulk- Madison',                       'aafb21f1-9d54-4829-953b-b6f32be67ac3'),
  ('mad', 4, 124, null, 'Nortera - Bulk - CSW-Madison',                 '9c8e2594-8e0e-48b6-a62b-6d05cae20ce6'),
  ('mad', 4, 303, null, 'Novonesis - Frozen - CSW-Madison',             '278c06dc-b210-4b5b-8591-e1fbf3287777'),
  ('mad', 4, 163, null, 'Mom''s Meals - CSW-Madison',                   'b2d15667-84b5-46bc-909f-4f8e8e9ce856'),
  ('mad', 4, 220, null, 'Saputo Finished Goods - CSW-Madison',          'c9891e3b-2305-494c-8f14-1ded0eee19de'),
  ('mad', 4, 199, null, 'Lactalis - CSW-Madison',                       '42616906-f47e-4e2a-a03d-f4767bef49df'),
  ('mad', 4,  89, null, 'Novonesis - Dry - CSW-Madison',                'fb36259f-9eb2-4d4d-9100-919aeb8e0901'),
  -- Wisconsin Rapids
  ('wr', 6, 320, null, 'Bernatello''s - Wisconsin Rapids',              'a36d9fff-6169-4419-96cf-58c55a85ab7d'),
  ('wr', 6, 347, null, 'Graceland Fruit - Wisconsin Rapids',            '7e3b5fcd-bb5f-4fd6-abe0-0d5c9ebd327a'),
  ('wr', 6, 317, null, 'LaGrander - Wisconsin Rapids',                  'a6486e4b-3dd4-4564-a546-2ac5e8c68ac0'),
  ('wr', 6, 315, null, 'McCain Foods - Wisconsin Rapids',               'b2ec9948-67ae-47e1-aefb-ebed5d915843')
) as v(facility, wid, pid, mg, pname, cid)
where exists (select 1 from space_forecast_customers c where c.id = v.cid::uuid)
on conflict do nothing;
