/*
  Separate trusted database-build operation for the second Python ETL.
  Create only SalesDatamart.dm.monthly_category_summary. Never drop/adopt an
  existing object, execute the original ETL, change principals, or rotate secrets.
  The existing loader's dm schema grant already covers DML on a new dm table.
*/
USE [SalesDatamart];
GO

SET XACT_ABORT ON;
IF OBJECT_ID(N'dm.monthly_category_summary') IS NOT NULL
    THROW 51000, 'Summary target already exists; reconcile instead of recreating', 1;

CREATE TABLE [dm].[monthly_category_summary](
    [MonthStart] date NOT NULL,
    [ProductCategoryID] int NOT NULL,
    [ProductCategoryName] nvarchar(50) NOT NULL,
    [LineCount] bigint NOT NULL,
    [OrderCount] bigint NOT NULL,
    [Quantity] bigint NOT NULL,
    [NetSales] decimal(38,6) NOT NULL,
    [SourceLineTotal] decimal(38,6) NOT NULL,
    CONSTRAINT [PK_monthly_category_summary]
        PRIMARY KEY CLUSTERED ([MonthStart], [ProductCategoryID]),
    CONSTRAINT [CK_monthly_category_summary_month] CHECK (DAY([MonthStart]) = 1),
    CONSTRAINT [CK_monthly_category_summary_counts] CHECK (
        [LineCount] > 0 AND [OrderCount] > 0 AND [OrderCount] <= [LineCount] AND [Quantity] > 0),
    CONSTRAINT [CK_monthly_category_summary_amounts] CHECK ([NetSales] >= 0 AND [SourceLineTotal] >= 0)
);
GO
