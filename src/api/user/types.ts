enum Comparator {
    eq = 'eq',
    neq = 'neq',
    lt = 'lt',
    lte = 'lte',
    gt = 'gt',
	gte = 'gte'
}

interface SimpleExpression {
	attribute: string;
	comparator: Comparator;
	value: string;
}

interface AndExpression {
	and: Expression[];
}

interface OrExpression {
	or: Expression[];
}

export type Expression = SimpleExpression | AndExpression | OrExpression;


export type UserId = {
    id: string
}

export type UsersIdList = {
    users: UserId[]
}


// Table 7: basic attributes of the viewer profile.
export type UserAttributes = {
    id: string,
    nickname: string,
    avatar?: string,
    parentalControl: boolean,
    maxContentRating?: string,
    audioLanguage?: string,
    closedCaptioningLanguage?: string,
    userInterfaceLanguage?: string,
    closedCaptioning: boolean,
    closedSigning: boolean,
    closedSigningSide?: 'left' | 'right',
    closedSigningWidth?: number,
    audioDescription: boolean,
    dialogEnhancement: boolean,
    voiceGuidance: boolean
} | string