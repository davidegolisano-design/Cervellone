-- Cervellone online: private data, server-authoritative commands.
create schema if not exists cervellone_private;
revoke all on schema cervellone_private from public, anon, authenticated;
create table cervellone_private.rooms (
 pin text primary key check(pin ~ '^[0-9]{6}$'),
 host_secret uuid not null default gen_random_uuid(),
 title text not null,
 phase text not null default 'lobby',
 questions jsonb not null default '[]',
 idx int not null default -1,
 round int not null default 1,
 started_at timestamptz,
 deadline timestamptz,
 duration int not null default 20,
 precount int not null default 5,
 reveal_delay int not null default 4,
 auto_advance boolean not null default true,
 leaderboard boolean not null default true,
 fullboard boolean not null default false,
 max_points int not null default 1300,
 penalty int not null default 200,
 free_skips int not null default 1,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '24 hours'
);
create table cervellone_private.players (
 id uuid primary key default gen_random_uuid(),
 secret uuid not null default gen_random_uuid(),
 pin text not null references cervellone_private.rooms on delete cascade,
 name text not null check(length(name) between 1 and 30),
 score int not null default 0,
 round_score int not null default 0,
 skips int not null default 0,
 seen_at timestamptz not null default now(),
 unique(pin,name)
);
create index on cervellone_private.players(pin);
create table cervellone_private.answers (
 pin text not null references cervellone_private.rooms on delete cascade,
 player_id uuid not null references cervellone_private.players on delete cascade,
 round int not null,
 idx int not null,
 choice int check(choice between 0 and 3),
 received_at timestamptz,
 delta int not null default 0,
 result text,
 primary key(player_id,round,idx)
);
create index on cervellone_private.answers(pin,round,idx);
create table cervellone_private.limits (
 bucket text primary key, count int not null, until_at timestamptz not null
);
create table cervellone_private.packs (id int primary key, questions jsonb not null);
alter table cervellone_private.rooms enable row level security;
alter table cervellone_private.players enable row level security;
alter table cervellone_private.answers enable row level security;
alter table cervellone_private.limits enable row level security;
alter table cervellone_private.packs enable row level security;

-- Internal helper. Called only under the gateway's service role.
create function cervellone_private.settle(p_pin text) returns void
language plpgsql set search_path = '' as $$
declare r cervellone_private.rooms; p cervellone_private.players; a cervellone_private.answers; d int; outcome text; t timestamptz:=clock_timestamp();
begin
 select * into r from cervellone_private.rooms where pin=p_pin for update;
 if r.phase <> 'question' then return; end if;
 for p in select * from cervellone_private.players where pin=p_pin loop
  select * into a from cervellone_private.answers where player_id=p.id and round=r.round and idx=r.idx;
  d:=0; outcome:='skip';
  if a.choice is not null then
   if a.choice=(r.questions->r.idx->>'correctIndex')::int then
    outcome:='correct';
    d:=round(r.max_points*0.6)+round(r.max_points*0.4*greatest(0,least(1,extract(epoch from (r.deadline-a.received_at))/r.duration)));
   else outcome:='wrong'; d:=-least(p.score,r.penalty); end if;
  elsif p.skips<r.free_skips then
   update cervellone_private.players set skips=skips+1 where id=p.id;
  else outcome:='missed'; d:=-least(p.score,r.penalty); end if;
  update cervellone_private.players set score=score+d,round_score=round_score+d where id=p.id;
  insert into cervellone_private.answers(pin,player_id,round,idx,delta,result)
   values(p_pin,p.id,r.round,r.idx,d,outcome)
   on conflict(player_id,round,idx) do update set delta=excluded.delta,result=excluded.result;
 end loop;
 update cervellone_private.rooms set phase='reveal',started_at=t,deadline=t+make_interval(secs=>r.reveal_delay) where pin=p_pin;
end; $$;
revoke all on function cervellone_private.settle(text) from public,anon,authenticated;

create function public.cervellone_api(p_action text, p_data jsonb default '{}', p_ip text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 r cervellone_private.rooms; p cervellone_private.players; a cervellone_private.answers;
 v_pin text:=p_data->>'pin'; v_secret text:=coalesce(p_data->>'secret','');
 v_role text:=coalesce(p_data->>'role','display'); v_host boolean:=false;
 t timestamptz:=clock_timestamp(); q jsonb; item jsonb; board jsonb; mine jsonb:=null;
 qs jsonb; v_name text; n int; tries int:=0; lim int; v_bucket text; counter int;
begin
 -- This gateway is inaccessible to anon/authenticated SQL callers.
 if current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    and coalesce(current_setting('request.jwt.claims',true),'{}')::jsonb->>'role' is distinct from 'service_role'
    and session_user <> 'postgres' then raise exception 'Accesso non autorizzato'; end if;
 if p_action not in ('create','join','state','answer','host') then raise exception 'Operazione non valida'; end if;
 if p_ip='' or length(p_ip)>100 then raise exception 'Identità richiesta'; end if;
 lim:=case p_action when 'create' then 5 when 'join' then 120 when 'state' then 12000 else 600 end;
 v_bucket:=p_action||':'||p_ip;
 insert into cervellone_private.limits values(v_bucket,1,t+case when p_action='create' then interval '1 hour' else interval '1 minute' end)
 on conflict(bucket) do update set count=case when cervellone_private.limits.until_at<t then 1 else cervellone_private.limits.count+1 end,
 until_at=case when cervellone_private.limits.until_at<t then excluded.until_at else cervellone_private.limits.until_at end returning count into counter;
 if counter>lim then return jsonb_build_object('error','Troppe richieste. Attendi prima di riprovare.','rateLimited',true); end if;
 begin
 if p_action='create' then
  -- Small bounded cleanup, with an index-friendly expiration policy.
  delete from cervellone_private.rooms where expires_at<t;
  delete from cervellone_private.limits where until_at<t and cervellone_private.limits.bucket<>p_action||':'||p_ip;
  v_name:=left(trim(coalesce(p_data->>'title','Serata quiz')),50);
  if v_name='' then v_name:='Serata quiz'; end if;
  select questions into qs from cervellone_private.packs where id=1;
  loop
   tries:=tries+1; v_pin:=(100000+floor(random()*900000))::int::text;
   begin
    insert into cervellone_private.rooms(pin,title,questions) values(v_pin,v_name,coalesce(qs,'[]')) returning * into r;
    exit;
   exception when unique_violation then if tries>20 then raise exception 'Riprova a creare la stanza'; end if;
   end;
  end loop;
  return jsonb_build_object('pin',r.pin,'secret',r.host_secret,'expiresAt',r.expires_at);
 end if;
 select * into r from cervellone_private.rooms where pin=v_pin for update;
 t:=clock_timestamp();
 if not found or r.expires_at<t then raise exception 'Stanza non trovata o scaduta'; end if;
 v_host:=v_secret=r.host_secret::text;
 if v_role='host' and not v_host then raise exception 'Accesso conduttore non autorizzato'; end if;
 if p_action='host' and not v_host then raise exception 'Accesso conduttore non autorizzato'; end if;
 if v_secret<>'' and not v_host then
  select * into p from cervellone_private.players where pin=v_pin and secret::text=v_secret;
 end if;
 if p_action='join' then
  if p.id is null then
   if r.phase<>'lobby' then raise exception 'La partita è già iniziata'; end if;
   if (select count(*) from cervellone_private.players where pin=v_pin)>=100 then raise exception 'Stanza piena (100 giocatori)'; end if;
   v_name:=trim(coalesce(p_data->>'name',''));
   if length(v_name) not between 1 and 30 then raise exception 'Inserisci un nome da 1 a 30 caratteri'; end if;
   if exists(select 1 from cervellone_private.players where pin=v_pin and lower(name)=lower(v_name)) then raise exception 'Questo nome è già utilizzato'; end if;
   insert into cervellone_private.players(pin,name) values(v_pin,v_name) returning * into p;
  end if;
  update cervellone_private.players set seen_at=t where id=p.id;
  return jsonb_build_object('pin',v_pin,'secret',p.secret,'name',p.name);
 end if;
 if v_role='player' or p_action='answer' then
  if p.id is null then raise exception 'Rientra nella stanza per continuare'; end if;
  update cervellone_private.players set seen_at=t where id=p.id;
 end if;
 -- Recover phases using database deadlines; no browser decides acceptance or score.
 if r.phase='precount' and t>=r.deadline then
  update cervellone_private.rooms set phase='question',started_at=r.deadline,deadline=r.deadline+make_interval(secs=>r.duration) where pin=v_pin returning * into r;
 end if;
 if r.phase='question' and t>=r.deadline then
  perform cervellone_private.settle(v_pin);
  select * into r from cervellone_private.rooms where pin=v_pin;
 end if;
 if r.phase='reveal' and r.auto_advance and t>=r.deadline then
  if r.idx+1>=jsonb_array_length(r.questions) then
   update cervellone_private.rooms set phase='final',deadline=null where pin=v_pin returning * into r;
  else
   update cervellone_private.rooms set phase='precount',idx=idx+1,started_at=t,deadline=t+make_interval(secs=>r.precount),fullboard=false where pin=v_pin returning * into r;
  end if;
 end if;
 if p_action='answer' then
  if r.phase<>'question' or t>=r.deadline or (p_data->>'idx')::int is distinct from r.idx or (p_data->>'round')::int is distinct from r.round then raise exception 'La domanda è chiusa'; end if;
  n:=(p_data->>'choice')::int;
  if n is null or n not between 0 and 3 then raise exception 'Risposta non valida'; end if;
  insert into cervellone_private.answers(pin,player_id,round,idx,choice,received_at) values(v_pin,p.id,r.round,r.idx,n,t)
   on conflict(player_id,round,idx) do nothing;
 end if;
 if p_action='host' then
  case p_data->>'command'
   when 'upload' then
    if r.phase not in ('lobby','final') then raise exception 'Termina la partita prima di cambiare domande'; end if;
    qs:=p_data->'questions';
    if jsonb_typeof(qs)<>'array' or jsonb_array_length(qs) not between 1 and 100 then raise exception 'Importa da 1 a 100 domande'; end if;
    for item in select value from jsonb_array_elements(qs) loop
     if jsonb_typeof(item->'question') is distinct from 'string' or length(item->>'question') not between 1 and 500
      or jsonb_typeof(item->'options') is distinct from 'array' then raise exception 'Formato domanda non valido'; end if;
     if jsonb_array_length(item->'options')<>4 or jsonb_typeof(item->'correctIndex') is distinct from 'number'
       or (item->>'correctIndex') !~ '^[0-3]$' then raise exception 'Ogni domanda richiede 4 opzioni e correctIndex da 0 a 3'; end if;
     for q in select value from jsonb_array_elements(item->'options') loop
      if jsonb_typeof(q)<>'string' or length(q#>>'{}') not between 1 and 200 then raise exception 'Opzione non valida'; end if;
     end loop;
     if (select count(distinct value) from jsonb_array_elements(item->'options'))<>4 then raise exception 'Le quattro opzioni devono essere diverse'; end if;
    end loop;
    select jsonb_agg(jsonb_build_object('question',value->>'question','options',value->'options','correctIndex',(value->>'correctIndex')::int,'category',left(coalesce(value->>'category','Quiz'),60),'difficulty',left(coalesce(value->>'difficulty',''),30))) into qs from jsonb_array_elements(qs);
    update cervellone_private.rooms set questions=qs,idx=-1,phase='lobby',deadline=null where pin=v_pin;
   when 'settings' then
    if r.phase not in ('lobby','final') then raise exception 'Modifica le regole prima della partita'; end if;
    update cervellone_private.rooms set duration=greatest(5,least(90,coalesce((p_data->>'duration')::int,duration))),
     max_points=greatest(100,least(10000,coalesce((p_data->>'maxPoints')::int,max_points))),
     penalty=greatest(0,least(5000,coalesce((p_data->>'penalty')::int,penalty))),
     free_skips=greatest(0,least(100,coalesce((p_data->>'freeSkips')::int,free_skips))),
     auto_advance=coalesce((p_data->>'autoAdvance')::boolean,auto_advance),
     leaderboard=coalesce((p_data->>'leaderboard')::boolean,leaderboard) where pin=v_pin;
   when 'start' then
    if r.phase not in ('lobby','final') or jsonb_array_length(r.questions)=0 then raise exception 'La partita è già in corso o non ci sono domande'; end if;
    if not exists(select 1 from cervellone_private.players where pin=v_pin) then raise exception 'Attendi almeno un giocatore'; end if;
    update cervellone_private.players set round_score=0,skips=0 where pin=v_pin;
    update cervellone_private.rooms set phase='precount',idx=0,round=round+1,started_at=t,deadline=t+make_interval(secs=>r.precount),fullboard=false where pin=v_pin;
   when 'next' then
    if r.phase<>'reveal' then raise exception 'Mostra prima il risultato'; end if;
    if r.idx+1>=jsonb_array_length(r.questions) then update cervellone_private.rooms set phase='final',deadline=null where pin=v_pin;
    else update cervellone_private.rooms set phase='precount',idx=idx+1,started_at=t,deadline=t+make_interval(secs=>r.precount),fullboard=false where pin=v_pin; end if;
   when 'reveal' then
    if r.phase<>'question' then raise exception 'Nessuna domanda aperta'; end if;
    perform cervellone_private.settle(v_pin);
   when 'end' then
    if r.phase='question' then perform cervellone_private.settle(v_pin); end if;
    update cervellone_private.rooms set phase='final',deadline=null where pin=v_pin;
   when 'fullboard' then update cervellone_private.rooms set fullboard=coalesce((p_data->>'visible')::boolean,false) where pin=v_pin;
   when 'reset' then
    if r.phase not in ('lobby','final') then raise exception 'Termina prima la partita'; end if;
    update cervellone_private.players set score=0,round_score=0,skips=0 where pin=v_pin;
    update cervellone_private.rooms set phase='lobby',idx=-1,deadline=null where pin=v_pin;
   when 'score' then
    update cervellone_private.players set score=greatest(0,least(1000000,(p_data->>'score')::int)) where pin=v_pin and id::text=p_data->>'playerId';
   when 'kick' then
    if r.phase not in ('lobby','final') then raise exception 'Rimuovi giocatori tra le partite'; end if;
    delete from cervellone_private.players where pin=v_pin and id::text=p_data->>'playerId';
   when 'rename' then
    v_name:=trim(coalesce(p_data->>'name',''));
    if length(v_name) not between 1 and 30 then raise exception 'Nome non valido'; end if;
    if exists(select 1 from cervellone_private.players where pin=v_pin and lower(name)=lower(v_name) and id::text<>p_data->>'playerId') then raise exception 'Nome già utilizzato'; end if;
    update cervellone_private.players set name=v_name where pin=v_pin and id::text=p_data->>'playerId';
   else raise exception 'Comando non valido';
  end case;
  select * into r from cervellone_private.rooms where pin=v_pin;
 end if;
 select coalesce(jsonb_agg(x order by (x->>'score')::int desc,x->>'name'),'[]') into board from (
  select jsonb_build_object('id',case when v_host then pl.id else null end,'name',pl.name,'score',pl.score,'roundScore',pl.round_score,
   'online',pl.seen_at>t-interval '15 seconds','answered',exists(select 1 from cervellone_private.answers aa where aa.player_id=pl.id and aa.round=r.round and aa.idx=r.idx and aa.choice is not null)) x
  from cervellone_private.players pl where pl.pin=v_pin
 ) b;
 if p.id is not null then
  select * into p from cervellone_private.players where id=p.id;
  select * into a from cervellone_private.answers where player_id=p.id and round=r.round and idx=r.idx;
  mine:=jsonb_build_object('name',p.name,'score',p.score,'roundScore',p.round_score,'choice',a.choice,'delta',a.delta,'result',a.result);
 end if;
 q:=null;
 if r.idx>=0 and (v_host or (v_role='display' and r.phase in ('question','reveal'))) then
  q:=r.questions->r.idx;
  if not v_host and r.phase<>'reveal' then q:=q-'correctIndex'; end if;
 end if;
 return jsonb_build_object('pin',r.pin,'title',r.title,'phase',r.phase,'idx',r.idx,'round',r.round,'total',jsonb_array_length(r.questions),
  'serverTime',t,'startedAt',r.started_at,'deadline',r.deadline,'duration',r.duration,'precount',r.precount,'question',q,
  'correctIndex',case when r.phase='reveal' then r.questions->r.idx->'correctIndex' else null end,
  'board',case when v_host or r.leaderboard or r.phase='final' or r.fullboard then board else '[]'::jsonb end,
  'players',(select count(*) from cervellone_private.players where pin=v_pin),
  'answered',(select count(*) from cervellone_private.answers where pin=v_pin and round=r.round and idx=r.idx and choice is not null),
  'mine',mine,'fullboard',r.fullboard,'expiresAt',r.expires_at,
  'settings',jsonb_build_object('maxPoints',r.max_points,'penalty',r.penalty,'freeSkips',r.free_skips,'autoAdvance',r.auto_advance,'leaderboard',r.leaderboard),
  'questions',case when v_host then r.questions else null end);
 exception when raise_exception then return jsonb_build_object('error',sqlerrm);
 when others then return jsonb_build_object('error','Richiesta non valida. Controlla i dati e riprova.');
 end;
end; $$;
revoke all on function public.cervellone_api(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.cervellone_api(text,jsonb,text) to service_role;
