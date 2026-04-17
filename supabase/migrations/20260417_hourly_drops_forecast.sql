-- Stores manually-entered estimated drop counts per facility, date, and hour.
-- Used by the EstDropsEditor in Settings and displayed in the Hourly Breakdown table.
create table hourly_drops_forecast (
  facility   text not null,
  plan_date  date not null,
  hour       int  not null check (hour between 0 and 23),
  est_drops  int  not null default 0,
  primary key (facility, plan_date, hour)
);
