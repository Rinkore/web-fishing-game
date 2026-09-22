\set ON_ERROR_STOP on

-- This file is executed by the isolated rehearsal only. Passwords are passed
-- as psql variables and never committed. The roles deliberately do not use
-- the bootstrap superuser for application traffic.
CREATE ROLE fishing_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE fishing_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD :'migration_password';
CREATE ROLE fishing_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'runtime_password';
CREATE ROLE fishing_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT REPLICATION PASSWORD :'backup_password';
CREATE ROLE fishing_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'ops_password';

-- Migration is an explicit operator action. Membership supplies ownership of
-- the schema objects after REASSIGN OWNED; runtime is never a member.
GRANT fishing_schema_owner TO fishing_migrator;
GRANT CREATE ON DATABASE fishing_test TO fishing_migrator;
GRANT CREATE ON SCHEMA public TO fishing_migrator;

-- Backup and monitoring are separate from the application role. pg_read_all_data
-- is read-only; REPLICATION is used only by pg_basebackup/WAL streaming.
GRANT pg_read_all_data TO fishing_backup;
GRANT pg_monitor TO fishing_ops;
GRANT pg_read_all_settings TO fishing_ops;
