/*
  Manual provisioning only. This script has NOT been executed by the author.
  Create just the new summary in the existing SalesDatamart database.
  Do not rerun the original schema/principal scripts or overwrite an existing table.
*/
USE [SalesDatamart];
GO

SET XACT_ABORT ON;
IF OBJECT_ID(N'dm.monthly_territory_summary') IS NOT NULL
    THROW 51000, 'Territory summary target already exists; reconcile instead of recreating', 1;

CREATE TABLE [dm].[monthly_territory_summary](
    [MonthStart] date NOT NULL,
    [TerritoryID] int NOT NULL,
    [TerritoryName] nvarchar(50) NOT NULL,
    [LineCount] bigint NOT NULL,
    [OrderCount] bigint NOT NULL,
    [Quantity] bigint NOT NULL,
    [NetSales] decimal(38,6) NOT NULL,
    [SourceLineTotal] decimal(38,6) NOT NULL,
    CONSTRAINT [PK_monthly_territory_summary]
        PRIMARY KEY CLUSTERED ([MonthStart], [TerritoryID]),
    CONSTRAINT [CK_monthly_territory_summary_month] CHECK (DAY([MonthStart]) = 1),
    CONSTRAINT [CK_monthly_territory_summary_counts] CHECK (
        [LineCount] > 0 AND [OrderCount] > 0 AND [OrderCount] <= [LineCount] AND [Quantity] > 0),
    CONSTRAINT [CK_monthly_territory_summary_amounts] CHECK ([NetSales] >= 0 AND [SourceLineTotal] >= 0)
);
GO
