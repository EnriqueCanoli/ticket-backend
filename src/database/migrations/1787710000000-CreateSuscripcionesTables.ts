import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea las cuatro tablas de la suscripción mensual (ver
 * src/suscripciones/README.md y flujo_suscripcion.md, sección 3):
 * - `suscripciones`: una fila por cuenta (UNIQUE `usuario_id`) con el estado
 *   guardado, la prueba de 14 días y el acceso pagado.
 * - `compras`: una fila por suscripción de la tienda (UNIQUE por
 *   `tienda` + `purchase_token`, base de la deduplicación).
 * - `pagos_historial`: un cobro por fila (UNIQUE por `tienda` + `external_id`).
 * - `eventos_tienda`: bitácora idempotente (UNIQUE `message_id`) de las
 *   notificaciones de la tienda (RTDN).
 *
 * Los valores enumerados son `varchar` + CHECK (no enums de Postgres) para
 * poder ampliarlos sin `ALTER TYPE` y sin romper el contrato con el
 * frontend. Los CHECK se nombran `CHK_*`, como `CHK_productos_costo`.
 * Las filas de `suscripciones` de las cuentas existentes las crea la
 * migración de datos siguiente (BackfillPruebaSuscripciones).
 */
export class CreateSuscripcionesTables1787710000000 implements MigrationInterface {
  name = 'CreateSuscripcionesTables1787710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "suscripciones" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "usuario_id" uuid NOT NULL,
        "estado" varchar(20) NOT NULL DEFAULT 'prueba',
        "prueba_inicio" timestamptz NOT NULL,
        "prueba_fin" timestamptz NOT NULL,
        "acceso_hasta" timestamptz NULL,
        "proximo_cobro" timestamptz NULL,
        "renovacion_automatica" boolean NOT NULL DEFAULT false,
        "tienda" varchar(20) NULL,
        "motivo" varchar(20) NULL,
        "estado_desde" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_suscripciones" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_suscripciones_usuario_id" UNIQUE ("usuario_id"),
        CONSTRAINT "FK_suscripciones_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_suscripciones_estado" CHECK ("estado" IN
          ('prueba', 'prueba_vencida', 'activa', 'cancelada', 'vencida', 'pago_en_proceso')),
        CONSTRAINT "CHK_suscripciones_prueba" CHECK ("prueba_fin" > "prueba_inicio"),
        CONSTRAINT "CHK_suscripciones_tienda" CHECK ("tienda" IN ('google_play', 'app_store')),
        CONSTRAINT "CHK_suscripciones_motivo" CHECK ("motivo" IN
          ('prueba_terminada', 'cancelada', 'cobro_fallido', 'reembolso'))
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "compras" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "usuario_id" uuid NOT NULL,
        "suscripcion_id" uuid NOT NULL,
        "tienda" varchar(20) NOT NULL,
        "producto_id" varchar(100) NOT NULL,
        "purchase_token" text NOT NULL,
        "order_id" varchar(100) NULL,
        "estado" varchar(20) NOT NULL DEFAULT 'pendiente',
        "periodo_inicio" timestamptz NULL,
        "periodo_fin" timestamptz NULL,
        "reconocida_en" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_compras" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_compras_tienda_purchase_token" UNIQUE ("tienda", "purchase_token"),
        CONSTRAINT "FK_compras_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_compras_suscripcion_id" FOREIGN KEY ("suscripcion_id")
          REFERENCES "suscripciones" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_compras_tienda" CHECK ("tienda" IN ('google_play', 'app_store')),
        CONSTRAINT "CHK_compras_estado" CHECK ("estado" IN
          ('pendiente', 'confirmada', 'reembolsada', 'expirada'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_compras_usuario_id" ON "compras" ("usuario_id");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_compras_suscripcion_id" ON "compras" ("suscripcion_id");`,
    );

    await queryRunner.query(`
      CREATE TABLE "pagos_historial" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "usuario_id" uuid NOT NULL,
        "compra_id" uuid NULL,
        "tienda" varchar(20) NOT NULL,
        "external_id" varchar(100) NOT NULL,
        "periodo" char(7) NOT NULL,
        "cobrado_en" timestamptz NOT NULL,
        "monto" numeric(10,2) NOT NULL,
        "moneda" char(3) NOT NULL DEFAULT 'MXN',
        "estado" varchar(20) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pagos_historial" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_pagos_historial_tienda_external_id" UNIQUE ("tienda", "external_id"),
        CONSTRAINT "FK_pagos_historial_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_pagos_historial_compra_id" FOREIGN KEY ("compra_id")
          REFERENCES "compras" ("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_pagos_historial_tienda" CHECK ("tienda" IN ('google_play', 'app_store')),
        CONSTRAINT "CHK_pagos_historial_periodo" CHECK ("periodo" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        CONSTRAINT "CHK_pagos_historial_monto" CHECK ("monto" >= 0),
        CONSTRAINT "CHK_pagos_historial_estado" CHECK ("estado" IN
          ('pagado', 'reembolsado', 'fallido'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_pagos_historial_usuario_cobrado"
        ON "pagos_historial" ("usuario_id", "cobrado_en" DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE "eventos_tienda" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tienda" varchar(20) NOT NULL DEFAULT 'google_play',
        "message_id" varchar(100) NOT NULL,
        "tipo" varchar(60) NULL,
        "payload" jsonb NOT NULL,
        "usuario_id" uuid NULL,
        "compra_id" uuid NULL,
        "recibido_en" timestamptz NOT NULL DEFAULT now(),
        "procesado_en" timestamptz NULL,
        "resultado" varchar(40) NULL,
        "error" text NULL,
        CONSTRAINT "PK_eventos_tienda" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_eventos_tienda_message_id" UNIQUE ("message_id"),
        CONSTRAINT "FK_eventos_tienda_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_eventos_tienda_compra_id" FOREIGN KEY ("compra_id")
          REFERENCES "compras" ("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_eventos_tienda_tienda" CHECK ("tienda" IN ('google_play', 'app_store'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_eventos_tienda_recibido_en" ON "eventos_tienda" ("recibido_en");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "eventos_tienda";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pagos_historial";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "compras";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "suscripciones";`);
  }
}
