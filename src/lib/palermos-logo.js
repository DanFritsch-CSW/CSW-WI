// src/lib/palermos-logo.js
//
// Palermo's ribbon-and-globe brand logo, base64-encoded PNG data URI.
// Used on both the standalone cswpvi.netlify.app site and the PVI tab
// inside the main csw-wi.netlify.app app.
//
// Source: 1783422808344_image.png. Grey bg made transparent, cropped,
// resized to 80px tall, FASTOCTREE-quantized to 32 colors so the whole
// data URI stays under 3KB.
//
// NOTE: the b64 is split across multiple concatenated string literals to
// avoid MCP transport corruption we saw with single 2000+ char lines
// (chars were inserted/dropped mid-string). Each chunk is under 500 chars
// so it survives transport cleanly.

const B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIEAAABQCAMAAAAJHOboAAAAflBMVEUfISHn5+eW' +
  'ICpaWlrBIzWdnZ0BdVhAqJBra2srKyv6+vpRUVHx8fFcFR39/f2srKwGSjk1NTU6' +
  'OjpCQkKhcnSoqKgAgV8/qZABAQEAAAABgmO5JzTCGzK0s7P+/v6ZmZkAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2BxaXAAAAIHRSTlP19f77//j//w+fmF4l' +
  '/loU/2kEhv6n///+AP////gF/e36gAgAAAXWSURBVHjaxZqNdqMsEIYHKVk1apK2' +
  '+30mW+D+73JnBjT+oIKm3TmnMRrKPL4zoPzAPcly/qzOtwKgHRpAccurQZlog4Sy' +
  'hj9y9N6GjShMX/LlBDm7X/T+pPgmDajay23LvYc4mwQdEjQo4vw7IS4v1+CS4J8Z' +
  'PqrInIwjMOc0/y4Wr9IAb2SHfzLKSfMKDUzR7jSSIT9OcFls/WhXNDoulSmq4xoE' +
  'IwBwOp0eA8PTa5ACDmtwDlQ6dj7ECGixmZCQCADXBfcdxZzhfITgY3b7j02bM5z3' +
  'E5zT/QcZzvf3PQTvU4DrI9qmDOeVRgnLHdG4FcQK4O06Vu+yjACLAON+4PpItLEM' +
  'YNI1MKMaTskAE4QilSC/38YAyQhoEJUKsACQwygF9gCMEaBaQICIp9E+91OEIiUK' +
  '+agh7lVgipCHRYDNNLweAHictkWALQngcchOmyLAlgSnYwTDOBQmUgNEPdATrYgQ' +
  '7hmHBMZcDFp+L14Vg0n/fDa5cU5CBPnz6vtAgv9Oh20gwuBmZwQ8yjEVWyO91fLX' +
  '/78OG1bTWeMckH8zITB3U5ZCKfsDppQWZdMjgAeohIT2xwxA9QgdQSm/2ykGYXiP' +
  'YqrBnAAItf/aujPojjREeJYYDhhgesEVSicALTAvhKL/0vyjxCv0RQr8xWohrRDa' +
  'Ck0geMX9mxQWsKTFWGNZUBorslYrAKlGWBEatEKwN6pfP6+07I98STwHOnEIMPgn' +
  'YBbFJQkfMMsUitCmE7ATNaz+eaQf8LplYZw8TAzuK/4q8a91uslWQmoeOD9aYN6i' +
  'tDMCkK0jUCy3cL/RQXpelA4wiIJb2ayhxRKQjMrJPSKQUjCBBOAMAMUgUlH5nkBQ' +
  '4Clt7LylxxFgrtFNYGo5YZ8EVjkCrX1EFCeH5sB7gq44IYhNDUxYA3cPWvQaz6Pg' +
  'KgdNX6SlzykBS6PmBCbvCPBpdV/MAzyg0qB9ug3aQusIuLUQAZJy1MEL5jMS+ETr' +
  'We3dAwrcM6lZJJDaZ1V/RXkCC5buVriGz7FhqA7QOnVcWTuvvanoAWWA3Wup5n2i' +
  'GNw3n9AHdiyCUwz7J1eCP50ankdyP9FJwYXneaAwZqJhDRru9+YEVmtN3RtpiydK' +
  'SYVXNDUxf5R0kVRSWMoCuO/YAwEWt6rr0hUWm7cFbkFSlAZK96uV7c9a34uDT6p/' +
  'RYBtvZH/lMA2YFySYLD0T5pyzRNKykRuKFbBsmU7rV6uUrroq+oO2CHzs1TD8lva' +
  'Tv9ZvfzGpDgKssTR0eVeaddzkjaW3mSmKPAnYBEIf+r5LKyUynIUfNecGxg+lVyB' +
  'GUqQIMbq9XpbSa+rRNDIMCv/C/U5b/sA3mrsc+yythwEfjKJlbdq6js/d0rwlmEL' +
  'kyv5RY9og5nY2I337M+dGmSfW52Magxl4tZQoc72RuFPvTEKAmoL4SAMpasR4G2P' +
  'YRjGEZ370ZQHjZoMbWgsIH4PRaDKCGLxZiMA2t88MFXjjMTWAK5Dcr7RdVk2DY9t' +
  'YYTwlR1UwM0i4eC8aUoc53TjJ+qVXRCwP0LfVT+kzvPLFOErybKvt1F/BNW96idQ' +
  'TIUYiiG0AQwCvSg03jnPopjZ1D7gHR0B8LNYXLlfDK0aHuA1UOKrP7vPzWh25f0+' +
  'XmLLvpJkyGBlhaHDaEorSyjZ/3hqJ7jKV0czzAQITiWyx0qUQP4vJrjWbybNp/6K' +
  'ZJgIsDihi0qYCkazSqtLDJgN2RYDF5g+EguzuL5Bjc6YlfXe2Won1OwjW3Q/978G' +
  '4McLa0vOVRHopJ3/IUb3PQt0w6sAm6t9eXjRua4DKmRZ8ClQbC09w96FdyCM/oWs' +
  'XngG0YqrObbqa3av/fuZ5JfsgKj2Lv8XMXtRIgj2boGI2n0QvQ8lfRuI25Dzsn0o' +
  'eCvVB6T6z19IwPlcResQff9J+5F4quUcsScodVNWwr40t+NsHQKKlNtP3hnnI8t7' +
  '4wLbPfp9cfk3EpB7/y6V325FUfA4GI+3s98aOFwtirO/b0FoyT8NivwAAAAASUVO' +
  'RK5CYII='

export const PALERMOS_LOGO = 'data:image/png;base64,' + B64
