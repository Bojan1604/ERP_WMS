-- Pretraga partnera bez dijakritika („slasticarnica" → „Slastičarnica").
-- Bez proširenja `unaccent`: translate() i lower() su ugrađene IMMUTABLE funkcije, pa funkcijski
-- trigram indeks radi na svakom PostgreSQL-u (Docker, Windows) bez prava za CREATE EXTENSION.
-- Izraz mora biti identičan onome u src/server/queries/partner-options.ts (FOLD_FROM/FOLD_TO u src/lib/fold.ts).
CREATE INDEX IF NOT EXISTS "Partner_name_fold_trgm_idx" ON "Partner" USING GIN ((lower(translate("name", 'čćžšđČĆŽŠĐáàâäãåéèêëíìîïóòôöõúùûüýÿñçÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÝÑÇ', 'cczsdCCZSDaaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC'))) gin_trgm_ops);
