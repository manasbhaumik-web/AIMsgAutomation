-- Local development only. The runtime role must NOT own tables and must NOT bypass RLS.
CREATE ROLE inbox_app LOGIN PASSWORD 'inbox_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE inbox TO inbox_app;
