-- Run this in the Supabase SQL editor once, on a fresh project.

create extension if not exists "pgcrypto";

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_description text,
  website text,
  phone text,
  email text,
  drive_folder_id text not null,
  organization_urn text not null,
  hashtag_count int default 5,
  caption_style text,
  created_at timestamptz default now()
);

create table if not exists scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  drive_file_id text not null,
  file_name text not null,
  mime_type text,
  scheduled_date date not null,
  status text not null default 'pending', -- pending | posted | failed
  caption text,
  hashtags text[],
  linkedin_post_id text,
  error text,
  posted_at timestamptz,
  created_at timestamptz default now(),
  unique (client_id, drive_file_id) -- a file can only ever be scheduled once per client
);

create index if not exists idx_scheduled_posts_client_date on scheduled_posts (client_id, scheduled_date);
create index if not exists idx_scheduled_posts_status on scheduled_posts (status);
