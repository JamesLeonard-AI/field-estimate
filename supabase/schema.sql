-- Field Estimate — database setup
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  address text default '',
  buyer text default '',
  seller text default '',
  status text not null default 'setup' check (status in ('setup','ready','done')),
  notes text default '',
  created_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  position int not null default 0,
  code text default '',
  area text default '',
  addendum_text text default '',
  inspection_text text default '',
  flag text default '',
  materials_cost numeric(10,2),
  labor_hours numeric(6,2),
  supply_list text default '',
  notes text default '',
  done boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists items_job_idx on items(job_id, position);

create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id) on delete cascade,
  kind text not null check (kind in ('inspection','field')),
  mime text,
  path text not null,
  created_at timestamptz not null default now()
);
create index if not exists media_item_idx on media(item_id);

-- Only signed-in staff can see or change anything.
alter table jobs  enable row level security;
alter table items enable row level security;
alter table media enable row level security;
drop policy if exists staff_all on jobs;  create policy staff_all on jobs  for all to authenticated using (true) with check (true);
drop policy if exists staff_all on items; create policy staff_all on items for all to authenticated using (true) with check (true);
drop policy if exists staff_all on media; create policy staff_all on media for all to authenticated using (true) with check (true);

-- Private storage bucket for photos, videos and inspection screenshots.
insert into storage.buckets (id, name, public) values ('media', 'media', false) on conflict (id) do nothing;
drop policy if exists staff_media on storage.objects;
create policy staff_media on storage.objects for all to authenticated
  using (bucket_id = 'media') with check (bucket_id = 'media');

-- Remember when a job was finished (used by the 90-day photo/video cleanup).
alter table jobs add column if not exists completed_at timestamptz;
create or replace function set_completed_at() returns trigger language plpgsql as $$
begin
  if new.status = 'done' and (old.status is distinct from 'done') then new.completed_at := now();
  elsif new.status <> 'done' then new.completed_at := null; end if;
  return new;
end $$;
drop trigger if exists jobs_completed_at on jobs;
create trigger jobs_completed_at before update of status on jobs for each row execute function set_completed_at();

-- Dropbox archive tracking
alter table jobs add column if not exists archived_at timestamptz;
alter table jobs add column if not exists archive_error text;
