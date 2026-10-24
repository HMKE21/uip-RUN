echo "▶ .NET project"
need dotnet
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_EnableWriteXorExecute=0 DOTNET_TieredCompilation=1 MSBUILDDISABLENODEREUSE=1 DOTNET_gcServer=0 DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK=1 DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1   # W^X memfd vs. the sandbox fsize limit: see lang.sh
export ASPNETCORE_URLS=http://0.0.0.0:5000 ASPNETCORE_ENVIRONMENT=Development DOTNET_ENVIRONMENT=Development
P=@ENTRY@
if [ -z "$P" ] || [ ! -f "$P" ]; then
  P=$(grep -rl --include='*.csproj' 'Sdk="Microsoft.NET.Sdk.Web"' . 2>/dev/null | sort | head -1)
  [ -n "$P" ] || P=$(grep -rl --include='*.csproj' '<OutputType>Exe' . 2>/dev/null | sort | head -1)
  [ -n "$P" ] || P=$(find . -maxdepth 3 -name '*.csproj' | sort | head -1)
fi
[ -n "$P" ] || { echo "✗ no .csproj found"; exit 1; }
echo "▶ dotnet run --project $P (first run restores NuGet packages)"
export DOTNET_TieredPGO=0 DOTNET_TC_QuickJitForLoops=1 DOTNET_ReadyToRun=1 NUGET_XMLDOC_MODE=skip
exec dotnet run --project "$P" --no-launch-profile -p:NuGetAudit=false -p:UseSharedCompilation=true -v q
