import RateReviewIcon from '@mui/icons-material/RateReview';
import { Badge, Box, Button, Typography } from '@mui/material';
import React, { useCallback } from 'react';

type ReviewButtonProps = {
    hidden?: boolean;
    isReviewing: boolean;
    pendingCommentCount: number;
    onStartReview: () => void;
    onStopReview: () => void;
};

export const ReviewButton: React.FunctionComponent<ReviewButtonProps> = ({
    hidden,
    isReviewing,
    pendingCommentCount,
    onStartReview,
    onStopReview,
}) => {
    const handleClick = useCallback(() => {
        if (isReviewing) {
            onStopReview();
        } else {
            onStartReview();
        }
    }, [isReviewing, onStartReview, onStopReview]);

    return (
        <Box hidden={hidden}>
            <Badge badgeContent={pendingCommentCount} color="primary" invisible={pendingCommentCount === 0}>
                <Button
                    startIcon={<RateReviewIcon />}
                    color={isReviewing ? 'primary' : 'inherit'}
                    variant={isReviewing ? 'contained' : 'outlined'}
                    onClick={handleClick}
                >
                    <Typography variant={'button'} noWrap>
                        {isReviewing ? 'Stop review' : 'Start review'}
                    </Typography>
                </Button>
            </Badge>
        </Box>
    );
};
