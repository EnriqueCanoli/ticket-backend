import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sucesora de AddUniqueNombreToProductos1787589148636: aquella migración documentaba
 * (JSDoc, líneas 13-18) que un índice sobre LOWER(nombre) sin unaccent era coherente
 * porque `normalizarNombre()` del cliente tampoco quitaba acentos. Esa premisa dejó de
 * ser cierta al unificar la normalización del frontend (ahora `normalizarNombre()`
 * también aplica normalize('NFD') + strip de diacríticos, igual que el comparador de
 * orden que ya usaba ProductosScreen.tsx) — sin este cambio, "Café" y "Cafe" pasarían
 * el chequeo local como duplicados pero el índice de Postgres seguiría dejándolos
 * coexistir, porque LOWER('Café') <> LOWER('Cafe').
 *
 * `unaccent()` (extensión `unaccent`) está marcada STABLE, no IMMUTABLE: depende del
 * contenido de un diccionario de text search que en teoría puede modificarse en
 * caliente (ALTER TEXT SEARCH DICTIONARY), así que Postgres no la acepta directamente
 * en la expresión de un índice, que exige funciones IMMUTABLE. El patrón estándar
 * (documentado en el wiki de Postgres para `unaccent`) es envolverla en una función SQL
 * propia marcada IMMUTABLE, delegando a la forma de dos argumentos
 * `unaccent(regdictionary, text)`. Dos detalles no obvios, encontrados al validar esto
 * contra una base real: (1) `CREATE INDEX` "inlinea" el cuerpo de la función SQL en vez
 * de invocarla como caja negra, y esa expansión resuelve nombres con una lógica más
 * estricta que una llamada normal — un literal sin cast (`'public.unaccent'`) revienta
 * ahí con "no existe la función unaccent(unknown, text)" aunque la misma llamada
 * funcione perfecto en un `SELECT` suelto, así que el literal necesita `::regdictionary`
 * explícito; (2) por la misma razón, `unaccent(...)` dentro del cuerpo debe ir calificado
 * como `public.unaccent(...)` — sin el prefijo de esquema, la expansión inline vuelve a
 * fallar con "no existe la función" aunque `public` esté en el `search_path`. Se acepta
 * el mismo riesgo teórico que documenta el wiki de Postgres: si alguna vez se
 * reconfigura el diccionario `unaccent`, este índice quedaría con valores obsoletos
 * hasta un `REINDEX`; no aplica hoy porque el diccionario nunca se toca en este
 * proyecto.
 *
 * Se reemplaza el índice existente (mismo nombre, `UQ_productos_usuario_id_nombre_lower`,
 * para que `NOMBRE_UNIQUE_INDEX` en productos.service.ts siga funcionando sin cambios)
 * en vez de agregar uno paralelo: el nuevo es un superconjunto del anterior (acentos +
 * mayúsculas), mantener ambos sería redundante y duplicaría el costo de escritura.
 */
export class AddUnaccentToProductosNombreIndex1787591323516 implements MigrationInterface {
  name = 'AddUnaccentToProductosNombreIndex1787591323516';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent;`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "immutable_unaccent"(text)
        RETURNS text AS
      $$
        SELECT public.unaccent('public.unaccent'::regdictionary, $1)
      $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_productos_usuario_id_nombre_lower";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_productos_usuario_id_nombre_lower"
        ON "productos" ("usuario_id", LOWER("immutable_unaccent"("nombre")))
        WHERE "activo" = true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_productos_usuario_id_nombre_lower";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_productos_usuario_id_nombre_lower"
        ON "productos" ("usuario_id", LOWER("nombre"))
        WHERE "activo" = true;
    `);

    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "immutable_unaccent"(text);`,
    );
    await queryRunner.query(`DROP EXTENSION IF EXISTS unaccent;`);
  }
}
