ENV?=.env
SIZES?=$(shell cat config/sizes.usd.txt)

install:
	npm i

build:
	npm run build

merge:
	bash scripts/merge_daily.sh

all: install build raydium orca merge
