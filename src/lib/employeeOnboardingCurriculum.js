// Employee Onboarding curriculum — reference content only (static, not user-
// editable in-app). Sourced verbatim in substance from Dan's
// Onboarding_Standardization_Notes.docx (shared via Tim Morris Slack thread,
// 2026-07-15). Fixed 3-month warehouse-floor new-hire training program +
// end-of-onboarding evaluation. Mirrors the doc's own convention: module
// title is always visible ("black bullet"), full description/objectives
// reveal on click ("white bullet") — see ModuleRow's expand toggle.
//
// Per-employee COMPLETION state (dates, grades, comments, observer names)
// lives in Supabase (eo_completions / eo_evaluations) — see
// src/lib/employeeOnboarding.js. This file only holds the fixed curriculum
// structure + keys used to address those rows.

export const MONTHS = [
  {
    key: 'm1',
    label: 'Month 1 — Unloading',
    value: {
      key: 'm1_values',
      title: 'Coachable & Service-Oriented',
      bullets: [
        'Trainer explains why we value coachability above all else.',
        'Trainer explains why being service-oriented as individuals allows the business to succeed and CSW to employ the team it does.',
      ],
    },
  },
  {
    key: 'm2',
    label: 'Month 2 — Loading',
    value: {
      key: 'm2_values',
      title: 'Accountable & Team-Based',
      bullets: [
        'Trainer explains what it means to be accountable and have ownership of your work at CSW (e.g. reporting when you damage something, not walking by wood on the ground).',
        'Trainer explains what it means to be team-based at CSW — how we succeed as individuals by helping the team succeed, and the team helps us succeed as individuals (e.g. helping someone else, being flexible and willing to change).',
      ],
    },
  },
  {
    key: 'm3',
    label: 'Month 3 — Putaways, Picking, Dropping',
    value: {
      key: 'm3_values',
      title: 'People First',
      bullets: [
        'Trainer explains what "people-first" means in practice at CSW. At the company level: health benefits, 401k match. At the day-to-day level: recognizing people for the work they do, saying thank you often.',
      ],
    },
  },
]

// Weekly observation logs — each week supports up to 10 individual load
// entries (date / grade / comments / observer). m3 has no grade field per
// the source doc (putaways/picks/drops observed, no diagram/receipt grade).
export const WEEKLY_CONFIG = {
  m1: { label: 'Unloads Observed', gradeLabel: 'Grade of inbound receipt', hasGrade: true, weeks: 4 },
  m2: { label: 'Loading Observed', gradeLabel: 'Grade of loading diagram', hasGrade: true, weeks: 4 },
  m3: { label: 'Putaways, Picks, Drops Observed', gradeLabel: null, hasGrade: false, weeks: 4 },
}
export const MAX_LOADS_PER_WEEK = 10

export const MODULES = {
  m1: [
    {
      key: 'm1_101', code: '101', title: 'Initial Training — Forklift Safety Certification',
      bullets: [
        'Honking to alert others when approaching corners or entering/exiting aisles.',
        'Safe driving speed limits within the warehouse.',
        'The height of doorways and proper clearance for forklifts with raised loads.',
        'How to perform daily forklift inspections — identifying issues like tire wear, hydraulic leaks, broken lights — and reporting them properly.',
        'Do not stand, sit, or ride anywhere on the forklift except the operator compartment; keep all limbs within the operator area.',
        'How careless forklift use can damage racking, product, or equipment, and how to avoid it.',
      ],
      objectives: 'Trainee demonstrates understanding of forklift safety rules and can conduct a complete daily inspection on each forklift type.',
    },
    {
      key: 'm1_102', code: '102', title: 'Initial Training — Warehouse Safety Rules Certification',
      bullets: [
        'Harness use & retrieval safety: always use a harness secured to a forklift or racking when retrieving tipped pallets/fallen cases; only approved fall-protection equipment for work at height; never climb racking; if product tips or falls, stop and follow facility recovery procedures.',
        'General warehouse safety: never walk under raised forklift loads; keep walkways/exits clear; proper lifting technique (bend at knees, team lift when needed); stay aware of forklift traffic and pedestrian paths; report unsafe conditions immediately; never use broken/improvised pallets or equipment for support.',
      ],
      objectives: null,
    },
    {
      key: 'm1_103_5', code: '103/5', title: 'Initial Training — Warehouse Map Walk and "Life of a Pallet"',
      bullets: [
        'Trainer provides a laminated warehouse map + marker for notes.',
        'Walk-through of layout — docks, racking systems, freezer storage, product location; dock names and zones with reference points.',
        'High-risk areas where product/equipment damage may occur, and how to avoid those risks.',
        'Trainer talks trainee through the "life of a pallet" — full inbound and outbound flow through dock and freezer environments (observation only, no forklift operation this session).',
        'How poor pallet handling (dragging, leaning, improper wrapping) causes product damage and how to prevent it.',
        'Trainee walks the facility, takes notes on the map, and at the end is asked to guide the trainer to a specific location.',
      ],
      objectives: 'Trainee can navigate the warehouse independently, using the map as a reference.',
    },
    {
      key: 'm1_104', code: '104', title: 'Initial Training — Maintenance Introduction',
      bullets: [
        'Daily forklift inspections — spotting and reporting mechanical issues early.',
        'Charging forklifts — process and best practices.',
        'Submitting maintenance work orders via Maintain-X.',
        'Safety & emergency procedures: ammonia leak response, fire safety/evacuation routes, Lock-out/Tag-out overview.',
        'Pest control stations and cleanliness standards; sanitation expectations and daily sweeping assignments.',
        'Why never walking by / kicking wood debris out of the way matters — team-based culture (next person doesn\'t run over it, Mx doesn\'t need to fix wheels) and accountability (ownership of the warehouse).',
        'Emergency contact numbers.',
        'How failure to report equipment/facility issues can cause product or infrastructure damage.',
      ],
      objectives: 'By session end, trainee can conduct daily forklift inspections, elevate safety issues properly, and understands emergency procedures and cleanliness importance.',
    },
    {
      key: 'm1_106', code: '106', title: 'Initial Training — "Life of a BOL / Pick Slip"',
      bullets: [
        'Roles & responsibilities — how CSRs and warehousemen interact during daily operations.',
        'Introduction to Datex — the WMS used for managing orders, receiving, and shipping.',
        'BOL (Bill of Lading) — process from arrival with a driver at the window to finalization.',
        'Pick slip — how it\'s generated in Datex, assigned to warehousemen, and filed after the pick is complete.',
        'The importance of documenting.',
      ],
      objectives: 'Trainee understands CSR roles, how Datex WMS functions relative to operations, and the BOL/pick-slip lifecycle.',
    },
    {
      key: 'm1_107', code: '107', title: 'Inbound Training — Trailer Conditions & Temp Standards',
      bullets: [
        'How to properly inspect a trailer and ensure it\'s safe for forklift operations.',
        'Inspecting inbound trailers for temperature (front/middle/back), damage (holes), cleanliness, and when CSW rejects a trailer.',
        'Identifying trailer conditions that justify rejection.',
        'How to turn a reefer on/off for drop trailers.',
        'Why and how to bypass the trailer hook and install a trailer lock.',
        'How poor trailer conditions (holes, excess moisture, wrong temp) cause product damage.',
      ],
      objectives: null,
    },
    {
      key: 'm1_109', code: '109', title: 'Inbound Training — Explaining Different "Receiving Status" in Datex',
      bullets: [
        '"Receiving" in Datex — the default location where pallets are scanned before putaway — and why pallets must not remain there.',
        'Other system-configured locations and where physical pallets should actually be staged.',
        'How improper staging (aisles, unstable stacking) can damage product or equipment.',
      ],
      objectives: 'Trainee can explain system-configured locations and why pallets never remain in receiving, and demonstrates accurate use of these locations after unloading/loading a truck.',
    },
    {
      key: 'm1_108', code: '108', title: 'Inbound Training — Receiving, ASN Receiving, LP Putaway in Datex',
      bullets: [
        'Regular receiving — standard procedures for receiving inventory.',
        'ASN (Advanced Shipping Notice) receiving — receiving against an ASN and verifying the shipment.',
        'LP (License Plate) putaway — properly labeling and storing product using LP numbers for tracking.',
        'Trainee physically uses a scanner for each task, observed by the trainer performing each multiple times.',
        'How incorrect scanning, labeling, or putaway can lead to lost or damaged product.',
      ],
      objectives: 'Trainee demonstrates proficiency using the scanner for each task and accurately completes receiving and putaway procedures.',
    },
    {
      key: 'm1_110', code: '110', title: 'Inbound Training — Inspecting Pallets / BOL',
      bullets: [
        'Which pallet discrepancies to look for (dirty, leaning, tipped, crushed, torn wrap, etc.) on every inbound/outbound trailer, and the proper steps before product is put away or shipped (photos, reporting to Supervisor/Inventory Specialist/Ops Manager).',
        'Three pallet discrepancies requiring immediate reporting.',
        'Inspecting for broken boards, leaning stacks, or exposed product to prevent loss or injury.',
        'Which customers require referencing the original BOL for receiving vs. the Datex Tally Sheet; ensuring accurate quantities and quality pallets during inbound.',
        'How to cross-check the BOL and tally sheet to catch product misplacements early.',
      ],
      objectives: 'Trainee understands how to read the BOL and use an Inbound Tally Sheet to confirm accurate product receipt; demonstrates use of the DVRS tablet per Inventory Specialist standards.',
    },
    {
      key: 'm1_111', code: '111', title: 'Damage/Inventory Discrepancy Reporting',
      bullets: [
        'How to complete a Damage & Variance Report (DVRS), where the tablet is located, and when a report should be submitted.',
        'Loose/unlabeled/unmovable/damaged pallets: take a photo, move to inventory zone, notify supervisor.',
        'Why these procedures are crucial to operations and how they assist issue resolution.',
        'When it arises, take advantage of Loadproof.',
      ],
      objectives: 'Trainee understands how to properly fill out a DVRS and recognizes all relevant scenarios requiring a report.',
    },
    {
      key: 'm1_112', code: '112', title: 'TI-HI and Case Layering',
      bullets: [
        'TI = number of cases per layer. HI = number of layers that determine pallet height.',
        'Different pallet configurations across multiple customers; matching case orientation for specific customers (e.g. Saputo, DPI).',
        'When stacking, reference existing full pallets for TI-HI configuration to maintain stability and prevent crushing/collapse during storage or transport.',
      ],
      objectives: 'Trainee understands the differences in TI-HI and layering orientations used throughout the warehouse.',
      // resourceLink: pending — Dan to share "Warehouse Tips and Tricks v1.1.pdf" (hosted or uploaded) so this can point to it.
      resourceLink: null,
      resourceLabel: 'Warehouse Tips and Tricks (v1.1)',
    },
    {
      key: 'm1_113', code: '113', title: 'FEFO / FIFO',
      bullets: [
        'FIFO (First-In, First-Out) vs. FEFO (First-Expired, First-Out), including customers requiring special FEFO attention (e.g. Saputo).',
        'Why proper FIFO/FEFO methods minimize spoilage and eliminate the risk of shipping expired or degraded product.',
      ],
      objectives: 'Trainee can differentiate FIFO and FEFO and identify which customers use each method.',
    },
    {
      key: 'm1_114', code: '114', title: 'Unloading Training — Per Customer',
      bullets: [
        'All ASN customers.',
        'For manual receipts, tracked as separate customers in-app (e.g. Customer 1 manual receipts, Customer 2 manual receipts).',
        'Live unload training.',
        'Drop trailer unload training.',
      ],
      objectives: null,
      perCustomer: true,
    },
  ],
  m2: [
    {
      key: 'm2_201', code: '201', title: 'How to Fill Out a Loading Diagram',
      bullets: [],
      objectives: null,
    },
    {
      key: 'm2_202', code: '202', title: 'Different Ways to Load',
      bullets: [
        'How to fit 26/28/30 pallets.',
        'Pinwheel, all-sideways, and other configurations.',
        'Reference the CSW Tips and Tricks PDF.',
      ],
      objectives: null,
      resourceLink: null,
      resourceLabel: 'Warehouse Tips and Tricks (v1.1)',
    },
    {
      key: 'm2_203', code: '203', title: 'How to Conduct a Multi-Stop Load',
      bullets: ['How to fill out a loading diagram with multiple orders.'],
      objectives: null,
    },
    {
      key: 'm2_204', code: '204', title: 'Wrapping Pallets',
      bullets: [
        'Trainer demonstrates how to use the pallet wrapper and identify pallets that need wrapping.',
        'Trainee demonstrates wrapping pallets by hand and with a pallet wrapper independently.',
      ],
      objectives: null,
    },
  ],
  m3: [
    {
      key: 'm3_301', code: '301', title: 'Reach Truck Introduction / Safety / Proficiency',
      bullets: ['Practice with stacks of pallets.'],
      objectives: null,
    },
    {
      key: 'm3_302', code: '302', title: 'Putaways',
      bullets: ['Correct locations.', 'Doubling up in rack.', 'Properly scanning.', 'Correct location / preferred housing.'],
      objectives: null,
    },
    {
      key: 'm3_dropping', code: null, title: 'Dropping',
      bullets: ['Paperwork properly filled out.', 'Writing destination/time on pallets when dropping.', 'Placarding, UCC label scanning.'],
      objectives: null,
    },
  ],
}

// ─── End-of-Onboarding Evaluation ───────────────────────────────────────────
// Every category gets an independent Trainer eval + Supervisor eval (free
// text — the source doc doesn't specify a rating scale, just dual sign-off).
export const END_EVAL_SECTIONS = [
  {
    key: 'equipment', title: 'Operate All Equipment', items: [
      { key: 'equip_operation', label: 'Pallet jacks, high reaches (Crown/Raymond), tablets, scanners' },
    ],
  },
  {
    key: 'housing', title: 'Preferred Housing', items: [
      { key: 'housing_understanding', label: 'Understanding of preferred housing (per customer)' },
    ],
  },
  {
    key: 'tasks', title: '"Doing" the Tasks', items: [
      { key: 'task_unloading', label: 'Unloading' },
      { key: 'task_loading', label: 'Loading' },
      { key: 'task_dropping', label: 'Dropping' },
      { key: 'task_putaway', label: 'Putaway' },
      { key: 'task_picking', label: 'Picking' },
    ],
  },
  {
    key: 'tech', title: 'Warehouse Technology', items: [
      { key: 'tech_takt', label: 'Takt' },
      { key: 'tech_maintainx', label: 'MaintainX' },
      { key: 'tech_loadproof', label: 'Loadproof' },
      { key: 'tech_datex', label: 'Datex NexGen' },
    ],
  },
  {
    key: 'accuracy', title: 'Accuracy', items: [
      { key: 'accuracy_osd', label: 'Any errors associated with name on OSD tracker' },
    ],
  },
  {
    key: 'values', title: 'CSW Values Fit', items: [
      { key: 'value_coachable', label: 'Coachable?' },
      { key: 'value_accountable', label: 'Accountable?' },
      { key: 'value_teambased', label: 'Team-Based?' },
      { key: 'value_service', label: 'Service-Oriented?' },
      { key: 'value_peoplefirst', label: 'People-First?' },
    ],
  },
]

export const FACILITIES = ['cal', 'mad', 'ken', 'wr', 'ec']
