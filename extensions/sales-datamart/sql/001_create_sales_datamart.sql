/*
  SalesDatamart v1 schema.
  Run as a separately controlled database-build identity, not as the ETL loader.
  This script never reads or writes AdventureWorks2019.
*/
USE [master];
GO

IF DB_ID(N'SalesDatamart') IS NULL
BEGIN
    CREATE DATABASE [SalesDatamart];
END;
GO

USE [SalesDatamart];
GO

IF SCHEMA_ID(N'dm') IS NULL
    EXEC(N'CREATE SCHEMA [dm] AUTHORIZATION [dbo]');
GO
IF SCHEMA_ID(N'reporting') IS NULL
    EXEC(N'CREATE SCHEMA [reporting] AUTHORIZATION [dbo]');
GO

IF OBJECT_ID(N'dm.dim_date', N'U') IS NULL
BEGIN
    CREATE TABLE [dm].[dim_date](
        [DateKey] int NOT NULL,
        [FullDate] date NOT NULL,
        [CalendarYear] smallint NOT NULL,
        [CalendarQuarter] tinyint NOT NULL,
        [CalendarMonth] tinyint NOT NULL,
        [MonthName] nvarchar(20) NOT NULL,
        [DayOfMonth] tinyint NOT NULL,
        CONSTRAINT [PK_dim_date] PRIMARY KEY CLUSTERED ([DateKey]),
        CONSTRAINT [UQ_dim_date_FullDate] UNIQUE ([FullDate]),
        CONSTRAINT [CK_dim_date_DateKey] CHECK ([DateKey] >= 0),
        CONSTRAINT [CK_dim_date_Unknown] CHECK (
            ([DateKey] = 0 AND [FullDate] = CONVERT(date, '19000101')) OR
            ([DateKey] > 0 AND [FullDate] <> CONVERT(date, '19000101'))
        )
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM [dm].[dim_date] WHERE [DateKey] = 0)
BEGIN
    INSERT INTO [dm].[dim_date]
        ([DateKey], [FullDate], [CalendarYear], [CalendarQuarter], [CalendarMonth], [MonthName], [DayOfMonth])
    VALUES
        (0, CONVERT(date, '19000101'), 0, 0, 0, N'Unknown', 0);
END;
GO

IF OBJECT_ID(N'dm.dim_territory', N'U') IS NULL
BEGIN
    CREATE TABLE [dm].[dim_territory](
        [TerritoryKey] int IDENTITY(1,1) NOT NULL,
        [SourceTerritoryID] int NOT NULL,
        [TerritoryName] nvarchar(50) NOT NULL,
        [CountryRegionCode] nvarchar(3) NOT NULL,
        [TerritoryGroup] nvarchar(50) NOT NULL,
        CONSTRAINT [PK_dim_territory] PRIMARY KEY CLUSTERED ([TerritoryKey]),
        CONSTRAINT [UQ_dim_territory_SourceTerritoryID] UNIQUE ([SourceTerritoryID])
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM [dm].[dim_territory] WHERE [TerritoryKey] = 0)
BEGIN
    SET IDENTITY_INSERT [dm].[dim_territory] ON;
    INSERT INTO [dm].[dim_territory]
        ([TerritoryKey], [SourceTerritoryID], [TerritoryName], [CountryRegionCode], [TerritoryGroup])
    VALUES
        (0, 0, N'Unknown', N'UNK', N'Unknown');
    SET IDENTITY_INSERT [dm].[dim_territory] OFF;
END;
GO

IF OBJECT_ID(N'dm.dim_product', N'U') IS NULL
BEGIN
    CREATE TABLE [dm].[dim_product](
        [ProductKey] int IDENTITY(1,1) NOT NULL,
        [SourceProductID] int NOT NULL,
        [ProductName] nvarchar(100) NOT NULL,
        [ProductNumber] nvarchar(25) NOT NULL,
        [SourceProductSubcategoryID] int NULL,
        [ProductSubcategoryName] nvarchar(50) NULL,
        [SourceProductCategoryID] int NULL,
        [ProductCategoryName] nvarchar(50) NULL,
        CONSTRAINT [PK_dim_product] PRIMARY KEY CLUSTERED ([ProductKey]),
        CONSTRAINT [UQ_dim_product_SourceProductID] UNIQUE ([SourceProductID])
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM [dm].[dim_product] WHERE [ProductKey] = 0)
BEGIN
    SET IDENTITY_INSERT [dm].[dim_product] ON;
    INSERT INTO [dm].[dim_product]
        ([ProductKey], [SourceProductID], [ProductName], [ProductNumber],
         [SourceProductSubcategoryID], [ProductSubcategoryName],
         [SourceProductCategoryID], [ProductCategoryName])
    VALUES
        (0, 0, N'Unknown', N'UNKNOWN', NULL, NULL, NULL, NULL);
    SET IDENTITY_INSERT [dm].[dim_product] OFF;
END;
GO

IF OBJECT_ID(N'dm.dim_customer', N'U') IS NULL
BEGIN
    CREATE TABLE [dm].[dim_customer](
        [CustomerKey] int IDENTITY(1,1) NOT NULL,
        [SourceCustomerID] int NOT NULL,
        [SourceTerritoryID] int NULL,
        [TerritoryKey] int NOT NULL,
        CONSTRAINT [PK_dim_customer] PRIMARY KEY CLUSTERED ([CustomerKey]),
        CONSTRAINT [UQ_dim_customer_SourceCustomerID] UNIQUE ([SourceCustomerID]),
        CONSTRAINT [FK_dim_customer_TerritoryKey] FOREIGN KEY ([TerritoryKey])
            REFERENCES [dm].[dim_territory]([TerritoryKey])
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM [dm].[dim_customer] WHERE [CustomerKey] = 0)
BEGIN
    SET IDENTITY_INSERT [dm].[dim_customer] ON;
    INSERT INTO [dm].[dim_customer]
        ([CustomerKey], [SourceCustomerID], [SourceTerritoryID], [TerritoryKey])
    VALUES
        (0, 0, NULL, 0);
    SET IDENTITY_INSERT [dm].[dim_customer] OFF;
END;
GO

IF OBJECT_ID(N'dm.fact_sales_order_line', N'U') IS NULL
BEGIN
    CREATE TABLE [dm].[fact_sales_order_line](
        [SalesOrderID] int NOT NULL,
        [SalesOrderDetailID] int NOT NULL,
        [OrderDateKey] int NOT NULL,
        [ProductKey] int NOT NULL,
        [CustomerKey] int NOT NULL,
        [TerritoryKey] int NOT NULL,
        [Status] tinyint NOT NULL,
        [CurrencyRateID] int NULL,
        [OrderQty] smallint NOT NULL,
        [UnitPrice] decimal(19,4) NOT NULL,
        [UnitPriceDiscount] decimal(19,4) NOT NULL,
        [LineNetAmount] decimal(19,6) NOT NULL,
        [SourceLineTotal] decimal(19,6) NOT NULL,
        CONSTRAINT [PK_fact_sales_order_line]
            PRIMARY KEY CLUSTERED ([SalesOrderID], [SalesOrderDetailID]),
        CONSTRAINT [FK_fact_OrderDateKey] FOREIGN KEY ([OrderDateKey])
            REFERENCES [dm].[dim_date]([DateKey]),
        CONSTRAINT [FK_fact_ProductKey] FOREIGN KEY ([ProductKey])
            REFERENCES [dm].[dim_product]([ProductKey]),
        CONSTRAINT [FK_fact_CustomerKey] FOREIGN KEY ([CustomerKey])
            REFERENCES [dm].[dim_customer]([CustomerKey]),
        CONSTRAINT [FK_fact_TerritoryKey] FOREIGN KEY ([TerritoryKey])
            REFERENCES [dm].[dim_territory]([TerritoryKey]),
        CONSTRAINT [CK_fact_OrderQty] CHECK ([OrderQty] > 0),
        CONSTRAINT [CK_fact_Discount] CHECK ([UnitPriceDiscount] >= 0 AND [UnitPriceDiscount] <= 1),
        CONSTRAINT [CK_fact_Amounts] CHECK ([LineNetAmount] >= 0 AND [SourceLineTotal] >= 0)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE [name] = N'IX_fact_sales_order_line_OrderDateKey')
    CREATE INDEX [IX_fact_sales_order_line_OrderDateKey]
        ON [dm].[fact_sales_order_line] ([OrderDateKey]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE [name] = N'IX_fact_sales_order_line_ProductKey')
    CREATE INDEX [IX_fact_sales_order_line_ProductKey]
        ON [dm].[fact_sales_order_line] ([ProductKey]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE [name] = N'IX_fact_sales_order_line_CustomerKey')
    CREATE INDEX [IX_fact_sales_order_line_CustomerKey]
        ON [dm].[fact_sales_order_line] ([CustomerKey]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE [name] = N'IX_fact_sales_order_line_TerritoryKey')
    CREATE INDEX [IX_fact_sales_order_line_TerritoryKey]
        ON [dm].[fact_sales_order_line] ([TerritoryKey]);
GO

CREATE OR ALTER VIEW [reporting].[v_sales_order_line]
AS
SELECT
    f.[SalesOrderID],
    f.[SalesOrderDetailID],
    d.[FullDate] AS [OrderDate],
    f.[OrderDateKey],
    f.[ProductKey],
    p.[SourceProductID],
    p.[ProductName],
    p.[ProductNumber],
    p.[ProductSubcategoryName],
    p.[ProductCategoryName],
    f.[CustomerKey],
    c.[SourceCustomerID],
    f.[TerritoryKey],
    t.[SourceTerritoryID],
    t.[TerritoryName],
    t.[CountryRegionCode],
    t.[TerritoryGroup],
    f.[Status],
    f.[CurrencyRateID],
    f.[OrderQty],
    f.[UnitPrice],
    f.[UnitPriceDiscount],
    f.[LineNetAmount],
    f.[SourceLineTotal]
FROM [dm].[fact_sales_order_line] AS f
JOIN [dm].[dim_date] AS d ON d.[DateKey] = f.[OrderDateKey]
JOIN [dm].[dim_product] AS p ON p.[ProductKey] = f.[ProductKey]
JOIN [dm].[dim_customer] AS c ON c.[CustomerKey] = f.[CustomerKey]
JOIN [dm].[dim_territory] AS t ON t.[TerritoryKey] = f.[TerritoryKey];
GO

REVOKE SELECT ON OBJECT::[reporting].[v_sales_order_line] FROM [public];
GO
