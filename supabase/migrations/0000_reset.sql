-- Clears pre-existing (empty, unrelated) tables found in this project
-- before 0001_init.sql lays down the real schema.
drop table if exists plays cascade;
drop table if exists ships cascade;
drop table if exists profiles cascade;
drop table if exists companies cascade;
