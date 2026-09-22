/*
  Privilege boundary for SalesDatamart.
  The two password variables are supplied by the trusted Host through sqlcmd -v;
  they are intentionally absent from the repository and from receipts.
*/
:setvar LOADER_LOGIN sales_datamart_loader
:setvar GRAFANA_LOGIN sales_datamart_grafana

USE [master];
GO

IF SUSER_ID(N'$(LOADER_LOGIN)') IS NULL
BEGIN
    DECLARE @loader_sql nvarchar(max) =
        N'CREATE LOGIN [' + N'$(LOADER_LOGIN)' + N'] WITH PASSWORD = ''' +
        REPLACE(N'$(LOADER_PASSWORD)', N'''', N'''''') +
        N''', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF';
    EXEC sys.sp_executesql @loader_sql;
END;
ELSE
BEGIN
    DECLARE @loader_alter nvarchar(max) =
        N'ALTER LOGIN [' + N'$(LOADER_LOGIN)' + N'] WITH PASSWORD = ''' +
        REPLACE(N'$(LOADER_PASSWORD)', N'''', N'''''') + N'''';
    EXEC sys.sp_executesql @loader_alter;
END;
GO

IF SUSER_ID(N'$(GRAFANA_LOGIN)') IS NULL
BEGIN
    DECLARE @grafana_sql nvarchar(max) =
        N'CREATE LOGIN [' + N'$(GRAFANA_LOGIN)' + N'] WITH PASSWORD = ''' +
        REPLACE(N'$(GRAFANA_PASSWORD)', N'''', N'''''') +
        N''', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF';
    EXEC sys.sp_executesql @grafana_sql;
END;
ELSE
BEGIN
    DECLARE @grafana_alter nvarchar(max) =
        N'ALTER LOGIN [' + N'$(GRAFANA_LOGIN)' + N'] WITH PASSWORD = ''' +
        REPLACE(N'$(GRAFANA_PASSWORD)', N'''', N'''''') + N'''';
    EXEC sys.sp_executesql @grafana_alter;
END;
GO

USE [SalesDatamart];
GO

IF DATABASE_PRINCIPAL_ID(N'$(LOADER_LOGIN)') IS NULL
    CREATE USER [$(LOADER_LOGIN)] FOR LOGIN [$(LOADER_LOGIN)];
IF DATABASE_PRINCIPAL_ID(N'$(GRAFANA_LOGIN)') IS NULL
    CREATE USER [$(GRAFANA_LOGIN)] FOR LOGIN [$(GRAFANA_LOGIN)];
GO

GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[dm] TO [$(LOADER_LOGIN)];
GRANT SELECT ON SCHEMA::[reporting] TO [$(LOADER_LOGIN)];
DENY ALTER ON SCHEMA::[dm] TO [$(LOADER_LOGIN)];
DENY ALTER ON SCHEMA::[reporting] TO [$(LOADER_LOGIN)];

GRANT SELECT ON SCHEMA::[reporting] TO [$(GRAFANA_LOGIN)];
DENY SELECT, INSERT, UPDATE, DELETE, ALTER ON SCHEMA::[dm] TO [$(GRAFANA_LOGIN)];
DENY INSERT, UPDATE, DELETE, ALTER ON SCHEMA::[reporting] TO [$(GRAFANA_LOGIN)];
GO
