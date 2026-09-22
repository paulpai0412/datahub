/*
  Operator-only, approval required: extend the EXISTING datahub_ingest login
  into SalesDatamart for metadata on exactly six objects. No new password,
  source-database change, business-row access, broad database role, or ETL run.
  Refuse an existing user; after an ambiguous result reconcile, do not replay.
*/
USE [SalesDatamart];
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;
    IF DB_NAME() <> N'SalesDatamart'
        THROW 51000, 'Unexpected database', 1;
    IF SUSER_ID(N'datahub_ingest') IS NULL
        THROW 51001, 'Expected existing login missing', 1;
    IF DATABASE_PRINCIPAL_ID(N'datahub_ingest') IS NOT NULL
        THROW 51002, 'User already exists; reconcile before proceeding', 1;
    IF OBJECT_ID(N'dm.dim_date', N'U') IS NULL
       OR OBJECT_ID(N'dm.dim_product', N'U') IS NULL
       OR OBJECT_ID(N'dm.dim_customer', N'U') IS NULL
       OR OBJECT_ID(N'dm.dim_territory', N'U') IS NULL
       OR OBJECT_ID(N'dm.fact_sales_order_line', N'U') IS NULL
       OR OBJECT_ID(N'reporting.v_sales_order_line', N'V') IS NULL
        THROW 51003, 'Expected case objects missing', 1;

    CREATE USER [datahub_ingest] FOR LOGIN [datahub_ingest];
    GRANT CONNECT TO [datahub_ingest];
    GRANT VIEW DEFINITION ON OBJECT::[dm].[dim_date] TO [datahub_ingest];
    GRANT VIEW DEFINITION ON OBJECT::[dm].[dim_product] TO [datahub_ingest];
    GRANT VIEW DEFINITION ON OBJECT::[dm].[dim_customer] TO [datahub_ingest];
    GRANT VIEW DEFINITION ON OBJECT::[dm].[dim_territory] TO [datahub_ingest];
    GRANT VIEW DEFINITION ON OBJECT::[dm].[fact_sales_order_line] TO [datahub_ingest];
    GRANT VIEW DEFINITION ON OBJECT::[reporting].[v_sales_order_line] TO [datahub_ingest];
    DENY SELECT, INSERT, UPDATE, DELETE, ALTER ON SCHEMA::[dm] TO [datahub_ingest];
    DENY SELECT, INSERT, UPDATE, DELETE, ALTER ON SCHEMA::[reporting] TO [datahub_ingest];
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
