import zipfile, datetime as dt
from zoneinfo import ZoneInfo
today = dt.datetime.now(ZoneInfo("Europe/Rome")).date()
ymd = today.strftime("%Y%m%d")
files = {
 "calendar.txt": f"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSV,1,1,1,1,1,1,1,{ymd},{ymd}\n",
 "routes.txt": "route_id,route_short_name\nR31,31\nR8,8\n",
 "trips.txt": "route_id,service_id,trip_id,trip_headsign\nR31,SV,T1,Termini\nR31,SV,T2,Termini\nR8,SV,T3,Casaletto\n",
 "stops.txt": "stop_id,stop_name\n79618,BALDELLI (Via)\n79619,Perché Stazione\n1,Capolinea\n",
 "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
   "T1,10:00:00,10:00:00,1,1\nT1,10:05:00,10:05:00,79619,2\nT1,10:10:00,10:10:00,79618,3\n"
   "T2,11:00:00,11:00:00,1,1\nT2,11:10:00,11:10:00,79618,3\n"
   "T3,09:00:00,09:00:00,79618,7\n",
}
with zipfile.ZipFile("test/fake_gtfs.zip","w") as z:
    for k,v in files.items(): z.writestr(k,v)
