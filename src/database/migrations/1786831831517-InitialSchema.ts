import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración inicial: crea las 4 tablas del modelo propuesto en
 * README_DB_PROPUESTA.md (usuarios, productos, tickets, ticket_items),
 * en orden que respeta las FKs, con todos los CHECK/default/ON DELETE
 * documentados ahí.
 */
export class InitialSchema1786831831517 implements MigrationInterface {
  name = 'InitialSchema1786831831517';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Requerido por gen_random_uuid() usado como default de las PK.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    // ---------------------------------------------------------------------
    // usuarios
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "usuarios" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar(255) NOT NULL,
        "password_hash" varchar(255) NOT NULL,
        "phone" varchar(10) NOT NULL,
        "pin_hash" varchar(255) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usuarios" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_usuarios_email" UNIQUE ("email")
      );
    `);

    // ---------------------------------------------------------------------
    // productos
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "productos" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "nombre" varchar(150) NOT NULL,
        "costo" numeric(10,2) NOT NULL DEFAULT 1,
        "precio_venta" numeric(10,2) NOT NULL DEFAULT 0,
        "costo_validado" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_productos" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_productos_costo" CHECK ("costo" >= 0),
        CONSTRAINT "CHK_productos_precio_venta" CHECK ("precio_venta" >= 0)
      );
    `);

    // ---------------------------------------------------------------------
    // tickets
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "tickets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "usuario_id" uuid NOT NULL,
        "total" numeric(12,2) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tickets" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_tickets_total" CHECK ("total" >= 0),
        CONSTRAINT "FK_tickets_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_tickets_usuario_id" ON "tickets" ("usuario_id");
    `);

    // ---------------------------------------------------------------------
    // ticket_items
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "ticket_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ticket_id" uuid NOT NULL,
        "producto_id" uuid NOT NULL,
        "cantidad" numeric(10,3) NOT NULL,
        "precio_venta_unitario" numeric(10,2) NOT NULL,
        "costo_unitario" numeric(10,2) NOT NULL,
        "subtotal" numeric(12,2) NOT NULL,
        CONSTRAINT "PK_ticket_items" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_ticket_items_cantidad" CHECK ("cantidad" > 0),
        CONSTRAINT "CHK_ticket_items_precio_venta_unitario" CHECK ("precio_venta_unitario" >= 0),
        CONSTRAINT "CHK_ticket_items_costo_unitario" CHECK ("costo_unitario" >= 0),
        CONSTRAINT "CHK_ticket_items_subtotal" CHECK ("subtotal" >= 0),
        CONSTRAINT "FK_ticket_items_ticket_id" FOREIGN KEY ("ticket_id")
          REFERENCES "tickets" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ticket_items_producto_id" FOREIGN KEY ("producto_id")
          REFERENCES "productos" ("id") ON DELETE RESTRICT
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ticket_items_ticket_id" ON "ticket_items" ("ticket_id");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ticket_items_producto_id" ON "ticket_items" ("producto_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Orden inverso de creación, respetando FKs.
    await queryRunner.query(`DROP TABLE IF EXISTS "ticket_items";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tickets";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "productos";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usuarios";`);
  }
}
