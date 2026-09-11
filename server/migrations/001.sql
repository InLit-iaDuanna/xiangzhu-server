CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY,name text NOT NULL,mode text NOT NULL CHECK(mode IN ('demo','reality')),version integer NOT NULL DEFAULT 0,spatial jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS members(project_id text NOT NULL REFERENCES projects(id),user_id text NOT NULL,role text NOT NULL CHECK(role IN ('recorder','analyst','reviewer','manager')),PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS records(id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),kind text NOT NULL,version integer NOT NULL DEFAULT 1,world_version integer NOT NULL,source text NOT NULL,data jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),stale boolean NOT NULL DEFAULT false);
CREATE INDEX IF NOT EXISTS records_project_kind ON records(project_id,kind);
CREATE TABLE IF NOT EXISTS world_versions(project_id text NOT NULL REFERENCES projects(id),version integer NOT NULL,spatial jsonb NOT NULL,source text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,version));
CREATE TABLE IF NOT EXISTS runs(id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),world_version integer NOT NULL,type text NOT NULL,status text NOT NULL,input jsonb NOT NULL,result jsonb, error text,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,cancel_requested boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS run_events(id bigserial PRIMARY KEY,run_id text NOT NULL REFERENCES runs(id),stage text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS confirmations(project_id text NOT NULL,proposal_id text NOT NULL UNIQUE,request_id text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(project_id,request_id));
CREATE TABLE IF NOT EXISTS materials(id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),name text NOT NULL,mime text NOT NULL,size integer NOT NULL,consent text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit(id bigserial PRIMARY KEY,project_id text,user_id text,action text NOT NULL,object_id text,payload jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS invitations(token text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),email text NOT NULL,role text NOT NULL,expires_at timestamptz NOT NULL,consumed boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS sync_receipts(project_id text NOT NULL,user_id text NOT NULL,request_id text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(project_id,user_id,request_id));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geographic_location jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS location_version integer NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS initialization jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS initialization_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS street_photos(id text PRIMARY KEY REFERENCES materials(id),project_id text NOT NULL REFERENCES projects(id),data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
